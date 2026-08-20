export interface SelectOption {
  value: string;
  label: string;
}

export interface BookingListAvailability {
  id: string;
  label: string;
  /** Seat-plan groups offered for this booking list (e.g. "Innenraum", "Galerie"). */
  seatplanGroups: SelectOption[];
  /** Seat-plan areas offered for this booking list. */
  seatplanAreas: SelectOption[];
  /** Person counts offered (simple booking flow). */
  paxOptions: SelectOption[];
  /** Number of people offered (simple booking flow). */
  simplePax: SelectOption[];
  /** Start times offered. */
  startTimes: SelectOption[];
}

export interface DateAvailability {
  date: string;
  label: string;
  bookingLists: BookingListAvailability[];
}

export interface PortalAvailability {
  portalId: string;
  name: string;
  url: string;
  bookingListGroupId?: string;
  closed: boolean;
  dates: DateAvailability[];
  error?: string;
  fetchedAt?: string;
}

export interface AvailabilitySnapshot {
  fetchedAt: string;
  portals: PortalAvailability[];
}

export interface PortalConfig {
  id: string;
  name: string;
  url: string;
  /** Maximum number of dates to check per run (undefined = all). */
  maxDates?: number;
}