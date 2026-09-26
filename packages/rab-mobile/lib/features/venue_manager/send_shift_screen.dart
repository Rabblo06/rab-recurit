import '../../core/widgets/schedule_feedback.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';
import 'venue_staff_directory.dart';

const _fieldBorder = Color(0xFFE2E8F0);
const _labelColor = Color(0xFF64748B);
const _navy = Color(0xFF0F172A);

class SendShiftScreen extends StatefulWidget {
  const SendShiftScreen({
    super.key,
    this.initialStaff = const {},
    this.existingEvent,
  });
  final Map<String, DirectoryUser> initialStaff;
  final VenueEvent? existingEvent;
  @override
  State<SendShiftScreen> createState() => _SendShiftScreenState();
}

/// Deliberate business-model simplification: `staffRequired` sent to
/// `POST /shifts/request` is always `selected.length` here — this screen no
/// longer supports asking for more staff than were personally hand-picked
/// (the backend's `Shift.requiredCount` field itself still supports that
/// independently of `shift_request_staff`'s row count, and the Internal
/// Manager's Venue Offers review can still add replacement staff up to
/// whatever count is needed after submission). Prior to this change the
/// "Number of staff required" field was a second, independently-typed
/// number; the new UI spec removes that input entirely in favour of always
/// showing the real selection count non-editably.
class _SendShiftScreenState extends State<SendShiftScreen> {
  final form = GlobalKey<FormState>();
  // Empty by default — a blank Break field means "use the venue's
  // configured default, or 30 minutes if the venue has none" (resolved
  // server-side, see SchedulingService.submitRequest); it is never
  // silently prefilled with a number the submitter didn't choose.
  final breaks = TextEditingController(),
      notes = TextEditingController(),
      pay = TextEditingController();
  late Map<String, DirectoryUser> selected = Map.of(widget.initialStaff);
  String? venueId, roleId, createdId, error;
  bool busy = false, uncertain = false, completed = false;
  DateTime date = DateUtils.dateOnly(
    DateTime.now().add(const Duration(days: 1)),
  );
  TimeOfDay start = const TimeOfDay(hour: 9, minute: 0),
      end = const TimeOfDay(hour: 17, minute: 0);
  bool get locked =>
      busy || createdId != null || uncertain || widget.existingEvent != null;
  DateTime get startsAt =>
      DateTime(date.year, date.month, date.day, start.hour, start.minute);
  DateTime get endsAt {
    final candidate = DateTime(
      date.year,
      date.month,
      date.day,
      end.hour,
      end.minute,
    );
    return candidate.isAfter(startsAt)
        ? candidate
        : candidate.add(const Duration(days: 1));
  }

  @override
  void initState() {
    super.initState();
    final e = widget.existingEvent;
    if (e != null) {
      createdId = e.id;
      venueId = e.json['venueId'] as String;
      roleId = e.json['jobRoleId'] as String;
      date = DateUtils.dateOnly(e.start);
      start = TimeOfDay.fromDateTime(e.start);
      end = TimeOfDay.fromDateTime(e.end);
      breaks.text = '${e.json['breakMinutes'] ?? 0}';
      notes.text = e.notes;
    }
  }

  @override
  void dispose() {
    breaks.dispose();
    notes.dispose();
    pay.dispose();
    super.dispose();
  }

  Future<void> chooseStaff() async {
    final result = await Navigator.of(context).push<Map<String, DirectoryUser>>(
      MaterialPageRoute(
        builder: (_) => VenueSelectStaffScreen(
          initialSelection: selected,
          startAt: startsAt.toUtc(),
          endAt: endsAt.toUtc(),
          excludeShiftId: createdId,
        ),
      ),
    );
    if (mounted && result != null) setState(() => selected = result);
  }

  Future<void> chooseTime(bool first) async {
    final result = await showTimePicker(
      context: context,
      initialTime: first ? start : end,
    );
    if (mounted && result != null) {
      setState(() {
        if (first) {
          start = result;
        } else {
          end = result;
        }
      });
    }
  }

  int? get payPence {
    if (pay.text.trim().isEmpty) return null;
    final parts = pay.text.trim().split('.');
    return int.parse(parts.first) * 100 +
        (parts.length == 1 ? 0 : int.parse(parts.last.padRight(2, '0')));
  }

  Future<void> send() async {
    if (busy || completed || uncertain) return;
    final p = context.read<VenueManagerProvider>();
    if (!form.currentState!.validate()) return;
    if (selected.isEmpty) {
      setState(() => error = 'Select at least one staff member.');
      return;
    }
    if (p.loading || p.error != null) return;
    if (!p.allows('staffing_request.create')) {
      setState(
        () => error =
            'Your account does not have permission to submit shift requests.',
      );
      return;
    }
    // An empty Break field means "use the server-resolved default" — there
    // is nothing to sanity-check client-side until that default is known,
    // so this guard only applies once the submitter has typed a value.
    final breakOverride = breaks.text.trim().isEmpty
        ? null
        : int.parse(breaks.text.trim());
    if (breakOverride != null &&
        breakOverride >= endsAt.difference(startsAt).inMinutes) {
      setState(() => error = 'Break must be shorter than the shift.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final dynamic response;
      if (createdId == null) {
        final request = await p.api.post(
          '/shifts/request',
          body: {
            'venueId': venueId,
            'jobRoleId': roleId,
            'startsAt': startsAt.toUtc().toIso8601String(),
            'endsAt': endsAt.toUtc().toIso8601String(),
            'breakMinutes': ?breakOverride,
            'staffRequired': selected.length,
            'staffProfileIds': selected.keys.toList(),
            if (notes.text.trim().isNotEmpty) 'note': notes.text.trim(),
            'payRatePence': ?payPence,
          },
        );
        createdId = request['id'] as String;
        completed = true;
        await p.refresh();
        if (!mounted) return;
        setState(() => busy = false);
        await showScheduleMessageSheet(
          context: context,
          title: 'Shift request submitted',
          message:
              'Your Internal Manager will review this request. Staff receive offers only after approval.',
          kind: ScheduleMessageKind.success,
        );
        if (mounted) Navigator.pop(context, createdId);
        return;
      } else {
        response = await p.api.post(
          '/shifts/$createdId/offers/bulk',
          body: {'staffProfileIds': selected.keys.toList()},
        );
      }
      final results = (response['results'] as List)
          .cast<Map<String, dynamic>>();
      final failures = results.where((r) => r['ok'] != true).toList();
      final success = results.length - failures.length;
      for (final result in results.where((r) => r['ok'] == true)) {
        selected.remove(result['staffProfileId']);
      }
      completed = failures.isEmpty;
      await p.refresh();
      if (!mounted) return;
      setState(() => busy = false);
      await showScheduleMessageSheet(
        context: context,
        title: failures.isEmpty ? 'Shift offers sent' : '$success offers sent',
        kind: failures.isEmpty
            ? ScheduleMessageKind.success
            : ScheduleMessageKind.warning,
        message: [
          'Staff acceptance still requires Manager confirmation.',
          for (final f in failures)
            '${selected[f['staffProfileId']]?.name ?? 'Staff member'}: ${f['message'] ?? 'Could not send offer.'}',
        ].join('\n\n'),
      );
      if (!mounted) return;
      if (completed) {
        Navigator.pop(context, createdId);
      } else {
        setState(
          () => error =
              'Some offers failed. Retry sends only the remaining recipients to this same shift.',
        );
      }
    } catch (e) {
      if (!mounted) return;
      // This API has no idempotency key. Do not blindly repeat an ambiguous
      // create request after a lost response and risk creating a second shift.
      if (createdId == null && (e is! ApiException || e.statusCode >= 500)) {
        uncertain = true;
      }
      setState(
        () => error = uncertain
            ? 'The send result could not be confirmed. Check Sent Shifts before creating another shift.'
            : e is ApiException
            ? e.message
            : 'Unable to send offers. Please try again.',
      );
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget field(String label, Widget child) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: const TextStyle(
          fontSize: 11.5,
          color: _labelColor,
          fontWeight: FontWeight.w500,
        ),
      ),
      const SizedBox(height: 6),
      child,
    ],
  );
  InputDecoration decoration({Widget? prefixIcon, Widget? suffixIcon}) =>
      InputDecoration(
        isDense: true,
        filled: true,
        fillColor: Colors.white,
        prefixIcon: prefixIcon,
        suffixIcon: suffixIcon,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
          borderSide: const BorderSide(color: _navy),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
      );
  Widget pair(Widget left, Widget right) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: left),
      const SizedBox(width: 10),
      Expanded(child: right),
    ],
  );

  /// A compact, non-native-looking button styled like the rest of the form's
  /// fields (thin border, small chevron) — used for Date/Start/End so they
  /// read as fields, not pill-shaped OutlinedButtons.
  Widget fieldButton({
    required IconData icon,
    required String label,
    required VoidCallback? onPressed,
  }) => SizedBox(
    height: 46,
    child: Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
      child: InkWell(
        borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
        onTap: onPressed,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(ScheduleTokens.fieldRadius),
            border: Border.all(color: _fieldBorder),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Icon(icon, size: 16, color: _labelColor),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, color: _navy),
                ),
              ),
              Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 18,
                color: _labelColor.withValues(
                  alpha: onPressed == null ? .4 : 1,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    return PopScope(
      canPop: !busy,
      child: Scaffold(
        backgroundColor: ScheduleTokens.homeBackground,
        body: SafeArea(
          bottom: false,
          child: p.loading || p.error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(ScheduleTokens.homeInset),
                    child: p.loading
                        ? const CircularProgressIndicator()
                        : ScheduleMessageCard(
                            title: 'Could not refresh staffing access',
                            message: p.error,
                            kind: ScheduleMessageKind.error,
                            actionLabel: 'Retry',
                            onAction: p.refresh,
                          ),
                  ),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(10, 6, 18, 4),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          IconButton(
                            tooltip: 'Back',
                            onPressed: () => Navigator.maybePop(context),
                            icon: const Icon(Icons.arrow_back, size: 20),
                            color: _navy,
                          ),
                          const SizedBox(width: 2),
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Send Shift',
                                  style: TextStyle(
                                    fontSize: 19,
                                    fontWeight: FontWeight.w700,
                                    color: _navy,
                                  ),
                                ),
                                Text(
                                  'Create and send a shift offer to staff',
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: _labelColor,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (!p.allows('staffing_request.create'))
                            const Tooltip(
                              triggerMode: TooltipTriggerMode.tap,
                              message:
                                  'Your account does not have permission to submit shift requests.',
                              child: SizedBox(
                                width: 40,
                                height: 48,
                                child: Icon(
                                  Icons.info_outline,
                                  size: 18,
                                  color: _labelColor,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: Form(
                        key: form,
                        child: ListView(
                          padding: const EdgeInsets.fromLTRB(18, 14, 18, 24),
                          children: [
                            pair(
                              field(
                                'Venue',
                                DropdownButtonFormField<String>(
                                  key: const ValueKey('send-venue'),
                                  initialValue:
                                      p.venues.any((v) => v['id'] == venueId)
                                      ? venueId
                                      : null,
                                  isExpanded: true,
                                  icon: const Icon(
                                    Icons.keyboard_arrow_down_rounded,
                                    size: 18,
                                  ),
                                  style: const TextStyle(
                                    fontSize: 13.5,
                                    color: _navy,
                                  ),
                                  decoration: decoration(
                                    prefixIcon: const Icon(
                                      Icons.storefront_outlined,
                                      size: 16,
                                      color: _labelColor,
                                    ),
                                  ),
                                  hint: const Text(
                                    'Select venue',
                                    style: TextStyle(fontSize: 13.5),
                                  ),
                                  items: [
                                    for (final v in p.venues)
                                      DropdownMenuItem(
                                        value: v['id'] as String,
                                        child: Text(
                                          v['name'] as String,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                  ],
                                  onChanged: locked
                                      ? null
                                      : (v) => setState(() => venueId = v),
                                  validator: (v) =>
                                      v == null ? 'Choose a venue' : null,
                                ),
                              ),
                              field(
                                'Role',
                                DropdownButtonFormField<String>(
                                  key: const ValueKey('send-role'),
                                  initialValue:
                                      p.jobRoles.any((r) => r['id'] == roleId)
                                      ? roleId
                                      : null,
                                  isExpanded: true,
                                  icon: const Icon(
                                    Icons.keyboard_arrow_down_rounded,
                                    size: 18,
                                  ),
                                  style: const TextStyle(
                                    fontSize: 13.5,
                                    color: _navy,
                                  ),
                                  decoration: decoration(
                                    prefixIcon: const Icon(
                                      Icons.badge_outlined,
                                      size: 16,
                                      color: _labelColor,
                                    ),
                                  ),
                                  hint: const Text(
                                    'Select role',
                                    style: TextStyle(fontSize: 13.5),
                                  ),
                                  items: [
                                    for (final r in p.jobRoles)
                                      DropdownMenuItem(
                                        value: r['id'] as String,
                                        child: Text(
                                          r['name'] as String,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                  ],
                                  onChanged: locked
                                      ? null
                                      : (v) => setState(() => roleId = v),
                                  validator: (v) =>
                                      v == null ? 'Choose a role' : null,
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            field(
                              'Date',
                              fieldButton(
                                icon: Icons.calendar_today_outlined,
                                label: DateFormat(
                                  'EEE d MMM yyyy',
                                ).format(date),
                                onPressed: locked
                                    ? null
                                    : () async {
                                        final d = await showDatePicker(
                                          context: context,
                                          initialDate: date,
                                          firstDate: DateTime(2020),
                                          lastDate: DateTime(2100),
                                        );
                                        if (mounted && d != null) {
                                          setState(() => date = d);
                                        }
                                      },
                              ),
                            ),
                            const SizedBox(height: 14),
                            pair(
                              field(
                                'Start time',
                                fieldButton(
                                  icon: Icons.schedule,
                                  label: DateFormat('HH:mm').format(startsAt),
                                  onPressed: locked
                                      ? null
                                      : () => chooseTime(true),
                                ),
                              ),
                              field(
                                'End time',
                                fieldButton(
                                  icon: Icons.schedule,
                                  label:
                                      '${DateFormat('HH:mm').format(endsAt)}${endsAt.day != startsAt.day ? ' (+1 day)' : ''}',
                                  onPressed: locked
                                      ? null
                                      : () => chooseTime(false),
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            field(
                              'Break (minutes)',
                              TextFormField(
                                key: const ValueKey('send-break'),
                                controller: breaks,
                                enabled: !locked,
                                keyboardType: TextInputType.number,
                                style: const TextStyle(fontSize: 13.5),
                                decoration: decoration(
                                  prefixIcon: const Icon(
                                    Icons.timer_outlined,
                                    size: 16,
                                    color: _labelColor,
                                  ),
                                ),
                                // Empty is a valid, intended state (use the
                                // server-resolved default) — only a
                                // non-empty, non-numeric or negative value
                                // is actually invalid.
                                validator: (v) => v == null || v.trim().isEmpty
                                    ? null
                                    : (int.tryParse(v.trim()) == null ||
                                              int.parse(v.trim()) < 0
                                          ? 'Enter zero or more minutes'
                                          : null),
                              ),
                            ),
                            const SizedBox(height: 14),
                            field(
                              'Number of staff required',
                              // Non-editable by design — the count shown is
                              // always derived from the real Staff
                              // selection, never a number the submitter can
                              // type themselves. "Select staff" is the only
                              // way to change it.
                              SizedBox(
                                height: 46,
                                child: Material(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(
                                    ScheduleTokens.fieldRadius,
                                  ),
                                  child: InkWell(
                                    key: const ValueKey('send-required'),
                                    borderRadius: BorderRadius.circular(
                                      ScheduleTokens.fieldRadius,
                                    ),
                                    onTap: busy || completed || uncertain
                                        ? null
                                        : chooseStaff,
                                    child: Container(
                                      decoration: BoxDecoration(
                                        borderRadius: BorderRadius.circular(
                                          ScheduleTokens.fieldRadius,
                                        ),
                                        border: Border.all(color: _fieldBorder),
                                      ),
                                      padding: const EdgeInsets.only(
                                        left: 12,
                                        right: 6,
                                      ),
                                      child: Row(
                                        children: [
                                          const Icon(
                                            Icons.groups_outlined,
                                            size: 16,
                                            color: _labelColor,
                                          ),
                                          const SizedBox(width: 8),
                                          Expanded(
                                            child: Text(
                                              '${selected.length} selected',
                                              overflow: TextOverflow.ellipsis,
                                              maxLines: 1,
                                              style: const TextStyle(
                                                fontSize: 13.5,
                                                color: _navy,
                                              ),
                                            ),
                                          ),
                                          const SizedBox(width: 6),
                                          // Capped at the system text scale
                                          // this small chip-style button was
                                          // designed at — otherwise a large
                                          // accessibility text scale grows
                                          // "Select staff" enough to overflow
                                          // this narrow, fixed-height field
                                          // (the live count text above
                                          // already carries the scaled
                                          // information the user needs).
                                          MediaQuery(
                                            data: MediaQuery.of(context)
                                                .copyWith(
                                                  textScaler:
                                                      TextScaler.noScaling,
                                                ),
                                            child: TextButton(
                                              style: TextButton.styleFrom(
                                                tapTargetSize:
                                                    MaterialTapTargetSize
                                                        .shrinkWrap,
                                                backgroundColor: _navy,
                                                foregroundColor: Colors.white,
                                                minimumSize: const Size(0, 32),
                                                padding:
                                                    const EdgeInsets.symmetric(
                                                      horizontal: 10,
                                                    ),
                                                shape: RoundedRectangleBorder(
                                                  borderRadius:
                                                      BorderRadius.circular(8),
                                                ),
                                                textStyle: const TextStyle(
                                                  fontSize: 12,
                                                  fontWeight: FontWeight.w600,
                                                ),
                                              ),
                                              onPressed:
                                                  busy || completed || uncertain
                                                  ? null
                                                  : chooseStaff,
                                              child: const Text('Select staff'),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Divider(
                                height: 1,
                                color: _navy.withValues(alpha: .08),
                              ),
                            ),
                            ExpansionTile(
                              tilePadding: EdgeInsets.zero,
                              childrenPadding: const EdgeInsets.only(
                                bottom: 12,
                              ),
                              title: const Text(
                                'More options',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: _labelColor,
                                ),
                              ),
                              shape: const Border(),
                              collapsedShape: const Border(),
                              children: [
                                field(
                                  'Notes (optional)',
                                  TextFormField(
                                    key: const ValueKey('send-notes'),
                                    controller: notes,
                                    enabled: !locked,
                                    minLines: 2,
                                    maxLines: 4,
                                    style: const TextStyle(fontSize: 13.5),
                                    decoration: decoration(),
                                  ),
                                ),
                                if (widget.existingEvent == null) ...[
                                  const SizedBox(height: 14),
                                  field(
                                    'Hourly pay (£, optional override)',
                                    TextFormField(
                                      key: const ValueKey('send-pay'),
                                      controller: pay,
                                      enabled: !locked,
                                      keyboardType:
                                          const TextInputType.numberWithOptions(
                                            decimal: true,
                                          ),
                                      style: const TextStyle(fontSize: 13.5),
                                      decoration: decoration(
                                        prefixIcon: const Icon(
                                          Icons.currency_pound,
                                          size: 16,
                                          color: _labelColor,
                                        ),
                                      ),
                                      validator: (v) =>
                                          v == null ||
                                              v.trim().isEmpty ||
                                              RegExp(
                                                r'^\d+(\.\d{1,2})?$',
                                              ).hasMatch(v.trim())
                                          ? null
                                          : 'Use pounds and up to two decimal places',
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            if (error != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 16),
                                child: ScheduleMessageCard(
                                  title: error!,
                                  kind: ScheduleMessageKind.error,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
        ),
        bottomNavigationBar: SafeArea(
          top: false,
          minimum: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
            child: SchedulePrimaryButton(
              label: 'Send Shift Offer',
              icon: Icons.send_outlined,
              busy: busy,
              onPressed:
                  busy ||
                      completed ||
                      uncertain ||
                      p.loading ||
                      p.error != null ||
                      !p.allows('staffing_request.create')
                  ? null
                  : send,
            ),
          ),
        ),
      ),
    );
  }
}
