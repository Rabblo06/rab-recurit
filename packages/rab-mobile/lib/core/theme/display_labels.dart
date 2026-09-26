/// A missing catalog name is not a user-facing database identifier.
String displayRoleName(String name) {
  final value = name.trim();
  final identifier = RegExp(
    r'^(?:Role-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  return value.isEmpty || identifier.hasMatch(value)
      ? 'Role unavailable'
      : value;
}
