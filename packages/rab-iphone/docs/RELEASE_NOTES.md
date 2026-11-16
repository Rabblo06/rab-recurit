# Venue Manager app release notes (iPhone and Flutter)

## 2026-11-15: unusual clock-in confirmation (server + both apps, PR #163)

**What changed**
- When a Venue Manager corrects a clock-in, or records attendance, with a time earlier than the staff member's scheduled start minus 15 minutes (`CLOCK_IN_EARLY_MINUTES`), the app shows a short "Unusual clock-in time" warning.
  - The warning shows "Earliest allowed" and "Entered time".
  - **Edit** goes back to the form, keeping what was typed.
  - **Confirm** saves it.
- A clock-in earlier than 12 hours before the scheduled start (`CLOCK_IN_CONFIRM_FLOOR_HOURS`) is always refused. The app shows the server's message as an error.
- Confirmed unusual times show "Unusual time confirmed" on the staff row of the shift report, in both apps and in the web console's timesheet.

**Older app versions** (installed before this release)
- The server now insists on the confirmation. An older app cannot send it, so for an unusually early clock-in:
  - **Correction** (Review staff report → Save correction): the save is refused and the app shows "This time is earlier than the normal allowance. Please check before continuing." The time is not saved.
  - **Record attendance:** before this release that time was refused outright ("cannot be more than 15 minutes before the scheduled start"). Older apps now show the same sentence, and the time is still not saved.
  - **Times beyond 12 hours:** refused with the server's message, on every version.
- Normal corrections and records (inside the allowance) work exactly as before on every version.
- Older apps do not show the "Unusual time confirmed" label; the times themselves are unaffected.
- **What to tell Venue Managers:** update the app to correct or record an unusually early clock-in.
