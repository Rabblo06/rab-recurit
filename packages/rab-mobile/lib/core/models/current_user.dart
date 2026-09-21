/// Mirrors `AuthService.me()`'s return shape in
/// `packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts`.
enum AppPresentation { staff, venueManager, manager, admin, unsupported }

class CurrentUser {
  final String id;
  final String email;
  final String firstName;
  final String lastName;
  final String organisationId;
  final List<String> roles;
  final bool mustResetPassword;
  final bool isPlatformAdmin;

  CurrentUser({
    required this.id,
    required this.email,
    required this.firstName,
    required this.lastName,
    required this.organisationId,
    required this.roles,
    required this.mustResetPassword,
    this.isPlatformAdmin = false,
  });

  factory CurrentUser.fromJson(Map<String, dynamic> json) {
    return CurrentUser(
      id: json['id'] as String,
      email: json['email'] as String,
      firstName: json['firstName'] as String,
      lastName: json['lastName'] as String,
      organisationId: json['organisationId'] as String,
      roles: (json['roles'] as List<dynamic>).map((e) => e as String).toList(),
      mustResetPassword: json['mustResetPassword'] as bool? ?? false,
      isPlatformAdmin: json['isPlatformAdmin'] as bool? ?? false,
    );
  }

  String get fullName => '$firstName $lastName';

  // Presentation only. Every API still independently enforces authorization.
  AppPresentation get presentation {
    if (isPlatformAdmin) return AppPresentation.admin;
    // Match the backend's more restrictive mixed-role resource scope.
    if (roles.contains('venue_manager')) return AppPresentation.venueManager;
    if (roles.contains('manager') || roles.contains('ceo')) {
      return AppPresentation.manager;
    }
    if (roles.contains('staff')) return AppPresentation.staff;
    return AppPresentation.unsupported;
  }
}
