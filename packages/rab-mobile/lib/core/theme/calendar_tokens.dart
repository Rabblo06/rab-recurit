import 'package:flutter/material.dart';
import 'schedule_tokens.dart';

abstract final class CalendarTokens {
  static const background = Color(0xFFF7F8FA);
  static const ink = ScheduleTokens.ink;
  static const muted = ScheduleTokens.muted;
  static const green = Color(0xFF13836B);
  static const blue = Color(0xFF7CA9E6);
  static const mint = Color(0xFF79CBBB);
  static const statusBackground = Color(0xFFE0F2EC);
  static const shadow = [
    BoxShadow(color: Color(0x08000000), blurRadius: 8, offset: Offset(0, 2)),
  ];
}

enum CalendarStatus {
  confirmed('Confirmed', CalendarTokens.blue),
  open('Open offer', CalendarTokens.mint),
  awaiting('Awaiting confirmation', CalendarTokens.mint),
  live('Live', CalendarTokens.green),
  clockedOut('Clocked Out', CalendarTokens.muted),
  complete('Complete', CalendarTokens.muted),
  ended('Ended', CalendarTokens.muted),
  declined('Declined', CalendarTokens.muted),
  rejected('Not confirmed', CalendarTokens.muted),
  expired('Expired', CalendarTokens.muted),
  cancelled('Cancelled', CalendarTokens.muted),
  openRequest('Open request', CalendarTokens.mint),
  partiallyFilled('Partially filled', CalendarTokens.mint),
  filled('Filled', CalendarTokens.blue),
  awaitingApproval('Awaiting approval', CalendarTokens.mint),
  offered('Offers sent', CalendarTokens.mint),
  draft('Draft', CalendarTokens.muted),
  other('Updating', CalendarTokens.muted);

  const CalendarStatus(this.label, this.dot);
  final String label;
  final Color dot;
}
