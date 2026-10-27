/**
 * Client capabilities that depend on UI shipped in a later U step (owner-approved order U2 → U3 → U5 → U8).
 *
 * `APPROVAL_CARDS_READY`: the chat can show and decide approval cards (U5 — shipped). Before U5 no entry point that leads
 * to a write proposal was offered ("Draft a rota"): a chip that cannot finish its job is not shown (never a faked result).
 * The chip still also needs the server's `writeTools` and the organisation's `features.approvals`.
 */
export const APPROVAL_CARDS_READY = true;

/** The write tool behind "Draft a rota" (Phase 5b, proposed through `propose_action`, decided on a card). */
export const DRAFT_ROTA_TOOL = 'create_draft_shift';

/** "Draft a rota" pre-fills this question; the person still presses send, and the result is a card to approve. */
export const DRAFT_ROTA_PROMPT = 'Draft next week’s rota as draft shifts for me to review and approve.';
