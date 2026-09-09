import { IconChevronDown } from '@tabler/icons-react';

/**
 * Smooth grid-template-rows accordion — animates to any content height
 * without a hardcoded max-height; disabled by `prefers-reduced-motion` via
 * CSS. Font/weight/height/animation values are taken directly from
 * twentyhq/twenty's own field-group header (see `.detail-accordion-*`
 * rules in index.css for the sourcing note). Shared by `UserDetailPanel`
 * and `CreateUserModal` — one implementation, not two, so the two panels
 * that make up "the same system" actually stay one.
 */
export default function AccordionSection({
  title,
  sectionKey,
  open,
  onToggle,
  children,
  id,
}: {
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  /** Optional DOM id for the body, so a caller can aria-controls/scroll to it (e.g. jumping to a section with a failed validation). */
  id?: string;
}) {
  return (
    <div className="detail-accordion">
      <button
        type="button"
        className="detail-accordion-header"
        onClick={() => onToggle(sectionKey)}
        aria-expanded={open}
        aria-controls={id}
      >
        <span>{title}</span>
        <IconChevronDown size={16} stroke={1.6} className={`detail-accordion-chevron${open ? ' open' : ''}`} />
      </button>
      <div className={`detail-accordion-body-wrap${open ? ' open' : ''}`}>
        <div className="detail-accordion-body-inner">
          <div className="detail-accordion-body" id={id}>{children}</div>
        </div>
      </div>
    </div>
  );
}
