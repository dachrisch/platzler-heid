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

export interface FestzeltOs2ApiConfig {
  /** Base URL of the Festzelt OS 2.0 landing-page JSON API (e.g. https://<tent>-api.festzelt-os.com/lp). */
  baseUrl: string;
  /** Company UID sent as the `x-festzelt-os-Company` header. */
  companyUid: string;
}

export interface PortalConfig {
  id: string;
  name: string;
  url: string;
  /** Maximum number of dates to check per run (undefined = all). */
  maxDates?: number;
  /**
   * When set, the portal is scraped through the Festzelt OS 2.0 JSON API
   * instead of the Livewire/Filament booking form.
   */
  api?: FestzeltOs2ApiConfig;
}