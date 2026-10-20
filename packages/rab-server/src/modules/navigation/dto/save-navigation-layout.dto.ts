import { ArrayMaxSize, IsArray, IsInt, IsUUID, Max, Min } from 'class-validator';
import { MAX_ITEMS } from '../navigation-layout.validation';

/**
 * Save of the caller's own navigation layout. Owner, organisation and workspace are NEVER in the body (they come from
 * the verified session); `forbidNonWhitelisted` turns any such field into a 400. Item shape is validated by
 * `validateNavigationItems` (allowlists, lengths, folders, links), which reports every problem at once.
 */
export class SaveNavigationLayoutDto {
  /** The revision the editor started from — a different current revision is a 409, never an overwrite. */
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  baseRevision!: number;

  /** Client-generated per Save attempt; a retry of the same attempt after a lost response is recognised, not re-applied. */
  @IsUUID()
  requestId!: string;

  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  items!: unknown[];
}
