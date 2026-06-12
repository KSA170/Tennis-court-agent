// Stable, NON-personal identifiers for Don Mills Tennis Club (org 6357), taken
// from the captured booking flow. Nothing here is sensitive, so it's safe in a
// public repo. Personal member records are injected at runtime from the
// CR_MEMBERS_JSON secret (see below) and never live in the repo.

export const ORG_ID = '6357';

// Booking context values that travel with a create-reservation request.
export const COST_TYPE_ID = '81915';        // aka MembershipId
export const CUSTOM_SCHEDULER_ID = '1218';
export const COURT_TYPE_ENUM = '2';
export const RESERVATION_TYPE_ID = '15214'; // the single-game type used in the capture

// Courts on this scheduler. Court 2 -> 22712 was confirmed; the rest are the
// contiguous ids seen in the availability request. Live availability echoes the
// labels, so findOpenCourt trusts live data and this is only a preference lookup.
export const COURTS = [
  { id: '22711', label: 'Court 1' },
  { id: '22712', label: 'Court 2' },
  { id: '22713', label: 'Court 3' },
  { id: '22714', label: 'Court 4' },
  { id: '22715', label: 'Court 5' },
  { id: '22716', label: 'Court 6' },
];
export const ALL_COURT_IDS = COURTS.map((c) => c.id).join(',');

// ---------------------------------------------------------------------------
// Personal member data — injected from the CR_MEMBERS_JSON env secret so it
// stays out of the (public) repo. Expected shape:
// {
//   "self": { "memberId","orgMemberId","orgMemberFamilyId","membershipNumber",
//             "firstName","lastName","email" },
//   "opponents": { "Angad Dev Singh": { ...same fields... }, "Karam Adam": {...} }
// }
// Opponents not listed here are still resolved live by name via the portal API.
// ---------------------------------------------------------------------------
const MEMBERS = (() => {
  try { return JSON.parse(process.env.CR_MEMBERS_JSON || '{}'); }
  catch (e) { console.warn('[constants] CR_MEMBERS_JSON is not valid JSON:', e.message); return {}; }
})();

export const SELF = MEMBERS.self || {};
export const KNOWN_OPPONENTS = MEMBERS.opponents || {};

/** True once the booking member's identity is configured. */
export function membersConfigured() {
  return !!(SELF && SELF.memberId && SELF.orgMemberId);
}
