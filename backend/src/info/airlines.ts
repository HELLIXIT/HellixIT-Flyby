/**
 * Offline fallback for IATA → ICAO airline codes and names, used when adsbdb is unreachable.
 * Covers the busiest carriers; everything else still works via adsbdb.
 */
export const AIRLINES: Record<string, [icao: string, name: string]> = {
  AA: ['AAL', 'American Airlines'], DL: ['DAL', 'Delta Air Lines'], UA: ['UAL', 'United Airlines'],
  WN: ['SWA', 'Southwest Airlines'], AS: ['ASA', 'Alaska Airlines'], B6: ['JBU', 'JetBlue'],
  NK: ['NKS', 'Spirit Airlines'], F9: ['FFT', 'Frontier Airlines'], HA: ['HAL', 'Hawaiian Airlines'],
  AC: ['ACA', 'Air Canada'], WS: ['WJA', 'WestJet'], AM: ['AMX', 'Aeroméxico'], Y4: ['VOI', 'Volaris'],
  BA: ['BAW', 'British Airways'], VS: ['VIR', 'Virgin Atlantic'], U2: ['EZY', 'easyJet'],
  FR: ['RYR', 'Ryanair'], EI: ['EIN', 'Aer Lingus'], LH: ['DLH', 'Lufthansa'], LX: ['SWR', 'Swiss'],
  OS: ['AUA', 'Austrian Airlines'], SN: ['BEL', 'Brussels Airlines'], EW: ['EWG', 'Eurowings'],
  AF: ['AFR', 'Air France'], KL: ['KLM', 'KLM'], IB: ['IBE', 'Iberia'], VY: ['VLG', 'Vueling'],
  UX: ['AEA', 'Air Europa'], TP: ['TAP', 'TAP Air Portugal'], AZ: ['ITY', 'ITA Airways'],
  SK: ['SAS', 'SAS'], AY: ['FIN', 'Finnair'], DY: ['NOZ', 'Norwegian'], W6: ['WZZ', 'Wizz Air'],
  LO: ['LOT', 'LOT Polish Airlines'], TK: ['THY', 'Turkish Airlines'], PC: ['PGT', 'Pegasus'],
  EK: ['UAE', 'Emirates'], QR: ['QTR', 'Qatar Airways'], EY: ['ETD', 'Etihad Airways'],
  SV: ['SVA', 'Saudia'], GF: ['GFA', 'Gulf Air'], WY: ['OMA', 'Oman Air'], FZ: ['FDB', 'flydubai'],
  MS: ['MSR', 'EgyptAir'], ET: ['ETH', 'Ethiopian Airlines'], KQ: ['KQA', 'Kenya Airways'],
  SA: ['SAA', 'South African Airways'], RJ: ['RJA', 'Royal Jordanian'], AI: ['AIC', 'Air India'],
  '6E': ['IGO', 'IndiGo'], UL: ['ALK', 'SriLankan Airlines'], SQ: ['SIA', 'Singapore Airlines'],
  TR: ['TGW', 'Scoot'], MH: ['MAS', 'Malaysia Airlines'], AK: ['AXM', 'AirAsia'], TG: ['THA', 'Thai Airways'],
  GA: ['GIA', 'Garuda Indonesia'], PR: ['PAL', 'Philippine Airlines'], VN: ['HVN', 'Vietnam Airlines'],
  CX: ['CPA', 'Cathay Pacific'], CI: ['CAL', 'China Airlines'], BR: ['EVA', 'EVA Air'],
  CA: ['CCA', 'Air China'], MU: ['CES', 'China Eastern'], CZ: ['CSN', 'China Southern'],
  HU: ['CHH', 'Hainan Airlines'], JL: ['JAL', 'Japan Airlines'], NH: ['ANA', 'All Nippon Airways'],
  KE: ['KAL', 'Korean Air'], OZ: ['AAR', 'Asiana Airlines'], QF: ['QFA', 'Qantas'], VA: ['VOZ', 'Virgin Australia'],
  JQ: ['JST', 'Jetstar'], NZ: ['ANZ', 'Air New Zealand'], LA: ['LAN', 'LATAM'], AV: ['AVA', 'Avianca'],
  CM: ['CMP', 'Copa Airlines'], G3: ['GLO', 'GOL'], AD: ['AZU', 'Azul'], AR: ['ARG', 'Aerolíneas Argentinas'],
  FX: ['FDX', 'FedEx'], '5X': ['UPS', 'UPS Airlines'], PO: ['PAC', 'Polar Air Cargo'], CV: ['CLX', 'Cargolux'],
};

export const AIRLINES_BY_ICAO: Record<string, { iata: string; name: string }> = Object.fromEntries(
  Object.entries(AIRLINES).map(([iata, [icao, name]]) => [icao, { iata, name }]),
);
