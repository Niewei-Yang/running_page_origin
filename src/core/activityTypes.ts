const normalizeActivityType = (type: string): string =>
  type.replace(/\s+/g, '').toLowerCase();

const TRANSPORT_ACTIVITY_TYPES = new Set(['roadtrip', 'flight', 'train']);
const DISPLAY_ONLY_TRANSPORT_TYPES = new Set(['flight', 'train']);

export const ACTIVITY_ROUTE_COLORS = {
  Run: '#f97316',
  Ride: '#3b82f6',
  Hike: '#22c55e',
  RoadTrip: 'rgb(154, 118, 252)',
  Flight: 'rgb(228, 212, 220)',
  Train: 'rgb(154, 118, 252)',
} as const;

export function isTransportActivity(type: string): boolean {
  return TRANSPORT_ACTIVITY_TYPES.has(normalizeActivityType(type));
}

// Matches the established Neewii_Worksout map treatment: flights and trains
// are display-only dashed routes, while road trips retain a normal solid line.
export function isDisplayOnlyTransportActivity(type: string): boolean {
  return DISPLAY_ONLY_TRANSPORT_TYPES.has(normalizeActivityType(type));
}

export function getActivityRouteColor(type: string): string {
  return (
    ACTIVITY_ROUTE_COLORS[type as keyof typeof ACTIVITY_ROUTE_COLORS] ??
    '#a855f7'
  );
}
