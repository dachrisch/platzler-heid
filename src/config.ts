import type { PortalConfig } from "./types.js";

/**
 * Festzelt OS reservation portals (Oktoberfest beer tents).
 * All of these run the same Livewire/Filament based "Festzelt OS" booking system,
 * so the same scraping protocol applies to each.
 */
export const PORTALS: PortalConfig[] = [
  {
    id: "ochsenbraterei",
    name: "Ochsenbraterei",
    url: "https://reservierung.ochsenbraterei.de/reservierungen",
  },
  {
    id: "paulaner-festzelt",
    name: "Paulaner Festzelt (Stiftl)",
    url: "https://reservierung.paulanerfestzelt.de/reservierung",
  },
  {
    id: "hofbraeu-festzelt",
    name: "Hofbräu Festzelt",
    url: "https://reservierung.hb-festzelt.de/reservierung",
  },
  {
    id: "schuetzenlisl",
    name: "Volkssängerzelt Schützenlisl",
    url: "https://reservierung.schuetzenlisl.de/",
  },
  {
    id: "zur-bratwurst",
    name: "Hochreiters zur Bratwurst",
    url: "https://reservierung.zur-bratwurst.de/reservierung",
  },
  {
    id: "kaiserschmarrn",
    name: "Café Kaiserschmarrn",
    url: "https://kaiserschmarrn.rischart.de/reservierung/",
  },
  {
    id: "poschners",
    name: "Poschner's Hühnerbraterei",
    url: "https://reservierung.poschners.de/",
  },
  {
    id: "fischer-vroni",
    name: "Fischer Vroni",
    url: "https://reservierung.fischer-vroni.de/reservation",
  },
  {
    id: "boandlkramerei",
    name: "Boandlkramerei",
    url: "https://reservierung.boandlkramerei.bayern/",
  },
  {
    id: "muenchner-stubn",
    name: "Münchener Stubn Festzelt",
    url: "https://reservierung.muenchnerstubn-festzelt.de/reservation",
  },
];

export function getPortal(id: string): PortalConfig | undefined {
  return PORTALS.find((p) => p.id === id);
}