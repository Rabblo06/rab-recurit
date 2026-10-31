/**
 * Phase C1 (API contract §1): the server's default page is 50 rows and its largest page 200 (`limit > 200` is a 400).
 * Every web list call names its `limit` explicitly, so a change of the server default can never silently shrink a
 * screen: tables page through `total` with `LIST_PAGE_SIZE`; screens that need every row in a range walk pages of
 * `MAX_PAGE_SIZE` with `fetchAllPages`.
 */
export const LIST_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
