// Existing operational views, shared by Object picker and Ctrl+K. No new entities.
export const OPERATIONAL_OBJECTS = {
  'open-shifts': { label:'Open Shifts', to:'/shifts/open', icon:'shift' },
  'draft-shifts': { label:'Draft Shifts', to:'/shifts/draft', icon:'pencil' },
  'completed-shifts': { label:'Completed Shifts', to:'/shifts/completed', icon:'checklist' },
  'pending-offers': { label:'Pending Offers', to:'/offers/pending', icon:'offer' },
  'awaiting-confirmation': { label:'Awaiting Confirmation', to:'/offers/awaiting-confirmation', icon:'clock' },
  'confirmed-offers': { label:'Confirmed Offers', to:'/offers/confirmed', icon:'circle-check' },
  'archived-venues': { label:'Archived Venues', to:'/venues/archived', icon:'archive' },
};
