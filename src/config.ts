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
  {
    id: "armbrustschuetzen",
    name: "Armbrustschützen-Festzelt",
    url: "https://reservierung.armbrustschuetzenzelt.de/reservierung",
  },
  {
    id: "braeurosl",
    name: "Bräurosl Festzelt",
    url: "https://reservierung.braeurosl.de/reservation",
  },
  {
    id: "loewenbraeu",
    name: "Löwenbräu-Festzelt",
    url: "https://reservierung.loewenbraeuzelt.de/reservierung",
  },
  {
    id: "hacker-festzelt",
    name: "Hacker Festzelt",
    url: "https://reservierung.derhimmelderbayern.de/reservierung",
  },
  {
    id: "augustiner",
    name: "Augustiner Festhalle",
    url: "https://reservierung.festhalle-augustiner.com/reservierung",
  },
  {
    id: "schuetzen",
    name: "Schützen-Festzelt",
    url: "https://reservierung.schuetzenfestzelt.com/reservation",
    api: {
      baseUrl: "https://schuetzen-api.festzelt-os.com/lp",
      companyUid: "M5RN1H1",
    },
  },
  {
    id: "schottenhamel",
    name: "Festhalle Schottenhamel",
    url: "https://reservierung.festhalle-schottenhamel.de/reservation",
    api: {
      baseUrl: "https://schottenhamel-api.festzelt-os.com/lp",
      companyUid: "KDLWJDR",
    },
  },
  {
    id: "weinzelt",
    name: "Kufflers Weinzelt",
    url: "https://reservierung.weinzelt.com/reservation",
    api: {
      baseUrl: "https://api.festzelt-os.com/lp",
      companyUid: "FOSKUFW4711",
    },
  },
];

export function getPortal(id: string): PortalConfig | undefined {
  return PORTALS.find((p) => p.id === id);
}