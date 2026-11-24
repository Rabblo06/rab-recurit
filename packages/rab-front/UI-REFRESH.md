# UI refresh — 23 November 2026

Updated existing components across the React web, Flutter Android and SwiftUI iPhone clients. No new application or parallel notification controller was created.

## Integrated

- [Sileo](https://sileo.aaryan.design/docs): web toast surface, behind the existing event bus, queue, deduplication, timers, persistence and action API. The Yarn patch fixes nested interactive markup, swipe dismissal synchronization, narrow widths, reduced motion and readable expanded messages. Custom actions opt out of swipe pointer capture. Keep this patch when upgrading Sileo until upstream equivalents are verified.
- [Blobatar](https://github.com/Alain00/blobatar): deterministic local SVG avatar fallbacks. Authenticated uploaded images and explicit fallbacks remain supported. Jest transforms these ESM packages rather than mocking the implementation.
- [Arc date picker](https://uiarc.dev/r/date-picker.json): reused its calendar dependency inside the existing DateInput portal and validation API. Monday-first British dates, inclusive limits, keyboard navigation and local calendar-day serialization are retained. No second date field was introduced.
- [Arc button](https://uiarc.dev/r/button.json): confirmation actions in the existing dialog. Vendored MIT source and attribution are in src/shared/components/arc. React 18 compatibility fixes use forwardRef and remove React 19-only inert props; inactive calendar views retain aria-hidden and disabled tab stops.
- Native toast implementations: rounded neutral surfaces, semantic icon badges, readable headings and a slim countdown. Flutter security copy feedback now uses the shared toast overlay. Existing mobile success-notification policy and iPhone errorsOnly policy remain intact.

## Reviewed resources and decisions

These resources were assessed, not all installed. Browser React components cannot run directly in Flutter or SwiftUI.

| Requested resource | Decision |
| --- | --- |
| Arc dialog | Keep the existing ModalFrame focus/escape handling; integrate Arc action buttons without a competing modal system. |
| Animate UI | Apply restrained motion and reduced-motion support through the existing motion system and Arc. Do not install every animation. |
| Smooth UI (both styling engines) | Existing old Reakit/styling peer requirements would add a competing style system; not installed. |
| Nivo bar | Existing charts already use Recharts. No chart behavior was requested that needs a second chart engine. |
| Rare UI fluid orb | Decorative effect with source-license restrictions; not ported to native clients. |
| Kokonut particle button | Reviewed; particle effects are not used for routine staffing or payroll confirmation actions. |
| Interior copy button | Existing copy actions retain their behavior and use the shared toast. No duplicate copy primitive. |
| Bencho like | No existing like workflow requiring a new control; no business behavior added. |
| Cult shift card | Reviewed as an animated card component, not a workforce shift data model; no parallel card implementation. |
| Pasta UI skills | Read design guidance; paid React 19/Tailwind 4 blocks do not match this React 18 application. |
| create-next-app, create-vite, shadcn init examples | Scaffolding commands intentionally omitted: update the existing applications as requested. |

Persistent form errors, offline banners, payroll review information and genuine confirmations remain inline or modal. Converting these to disappearing messages would hide information users need to complete a task.

## Verification and limits

Focused web tests cover toast lifecycle/actions, date validation/selection and avatar upload integration. Flutter tests cover queueing, timing, duplicates, accessibility, large text, reduced motion and security feedback. Browser fixtures exercise the actual production components with Playwright at 375, 768 and 1280 pixels, in light/dark mode and a non-UTC timezone. Fixtures and screenshots live under ignored .audit/ui-refresh-20261123; they do not change business records.

The Android debug build was installed on the existing emulator with data preserved. SwiftUI source was updated, but this Windows environment cannot build or visually verify the iPhone app; Xcode/device verification remains required. This is a shared-component refresh, not a claim that every application screen has been redesigned.
