/// Mirrors `AuthService.me()`'s return shape in
/// `packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts`.
class CurrentUser {
  final String id;
  final String email;
  final String firstName;
  final String lastName;
  final String organisationId;
  final List<String> roles;
  final bool mustResetPassword;

  CurrentUser({
    required this.id,
    required this.email,
    required this.firstName,
    required this.lastName,
    required this.organisationId,
    required this.roles,
    required this.mustResetPassword,
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
    );
  }

  String get fullName => '$firstName $lastName';
}
