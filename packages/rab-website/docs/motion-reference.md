# Motion direction, before implementation

Available evidence: supplied OpenShip desktop screenshot, written motion brief, public OpenShip page structure. All three attached text briefs have identical SHA-256 hashes. No video or hero component source is attached or found in the workspace; frame-by-frame reference analysis and source refactoring are therefore unavailable, not claimed complete.

Screenshot observations: floating compact navigation, substantial central whitespace, two contrasting headline lines, small eyebrow, paired pill CTAs, low-contrast supporting text and diffuse colour below the hero. These composition principles inform an original recruitment design; no source/branding copied.

Implementation storyboard: navigation settles in; headline and supporting content reveal in a short stagger; warm ambient light drifts behind the recruitment stack; desktop pointer tilts the illustration gently; one sector marquee pauses on hover/focus or its explicit pause control; a dark vertical recruitment flow illuminates nodes and draws connecting lines as they enter the viewport. One sticky process heading on large screens. Cards lift slightly; footer stays still.

Tokens live in styles/globals.css. Native IntersectionObserver enables one-shot section reveals and workflow progress, cleaned up on unmount. No scroll hijacking or permanent requestAnimationFrame loop. Reduced motion renders final states immediately and removes ambient, marquee, pointer and reveal movement. Mobile removes depth/overlap and sticky positioning. Production browser QA will record scroll frames and a local video; exact reference-video comparison awaits the missing asset.


## Second-section update ? 25 September 2026

Reviewed the later 17-page supplied PDF as still compositions: raised central image/window, asymmetric outer cards and small front card are relevant to this section. The PDF cannot prove timing; the actual reference video remains unavailable. The latest written brief establishes the implemented sequence: editorial copy, left, right, image, spotlight, statement, sector navigation. Existing ease tokens are reused with local 1050ms card duration and 110ms stagger. Desktop differential depth distances are -20/-36/-14/+12px, with pointer bounds 4/7/4/3px. Group exit is bounded to scale .985 and opacity .94. Mobile replaces the composition with a straight stack. Cleanup and reduced-motion/no-JS behavior are covered by browser checks. See the 9.08s local recording and 20-frame contact sheet in qa/recruitment-story; these document this implementation, not reference-video parity.
