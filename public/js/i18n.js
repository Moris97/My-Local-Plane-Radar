const DICTIONARIES = {
  en: {
    list: 'List',
    stats: 'Stats',
    settings: 'Settings',
    close: 'Close',
    aircraftCount: 'Aircraft',
    messagesPerSecond: 'Messages/sec',
    units: 'Units',
    altitudeFilter: 'Altitude filter',
    layers: 'Layers',
    showMoreDetails: 'Show more details',
    noAircraft: 'No aircraft in range',
    flight: 'Flight',
    altitude: 'Altitude',
    speed: 'Speed',
    type: 'Type',
    onGround: 'On ground',
    hideBelow: 'Hide below',
    hideAbove: 'Hide above',
    metric: 'Metric (km, m)',
    imperial: 'Imperial (nm, ft)',
    basemap: 'Basemap',
    trails: 'Trails',
    maxRange: 'Max range',
    homeLocation: 'Home location',
    homeAutoDetected: 'Auto-detected from receiver',
    homeManual: 'Manually set',
    homeNotSet: 'Not set',
    save: 'Save',
    resetToAuto: 'Reset to auto-detected',
    aircraftHistory: 'Aircraft (last 24h)',
    messagesHistory: 'Messages/min (last 24h)',
    notifications: 'Notifications',
    squawkAlerts: 'Squawk alerts',
    firstSeen: 'First time seen aircraft',
    rangeRecord: 'New range record',
    ntfyInstructions: 'To receive push notifications, install the ntfy app and enter this code as the topic:',
    regenerateTopic: 'Generate new code',
  },
  pl: {
    list: 'Lista',
    stats: 'Statystyki',
    settings: 'Ustawienia',
    close: 'Zamknij',
    aircraftCount: 'Samoloty',
    messagesPerSecond: 'Wiadomości/s',
    units: 'Jednostki',
    altitudeFilter: 'Filtr wysokości',
    layers: 'Warstwy',
    showMoreDetails: 'Pokaż więcej szczegółów',
    noAircraft: 'Brak samolotów w zasięgu',
    flight: 'Lot',
    altitude: 'Wysokość',
    speed: 'Prędkość',
    type: 'Typ',
    onGround: 'Na ziemi',
    hideBelow: 'Ukryj poniżej',
    hideAbove: 'Ukryj powyżej',
    metric: 'Metryczne (km, m)',
    imperial: 'Imperialne (nm, ft)',
    basemap: 'Mapa bazowa',
    trails: 'Trasy',
    maxRange: 'Maks. zasięg',
    homeLocation: 'Lokalizacja odbiornika',
    homeAutoDetected: 'Wykryto automatycznie z odbiornika',
    homeManual: 'Ustawiono ręcznie',
    homeNotSet: 'Nie ustawiono',
    save: 'Zapisz',
    resetToAuto: 'Przywróć automatyczne wykrywanie',
    aircraftHistory: 'Samoloty (ostatnie 24h)',
    messagesHistory: 'Wiadomości/min (ostatnie 24h)',
    notifications: 'Powiadomienia',
    squawkAlerts: 'Alerty squawk',
    firstSeen: 'Pierwszy raz widziany samolot',
    rangeRecord: 'Nowy rekord zasięgu',
    ntfyInstructions: 'Aby otrzymywać powiadomienia push, zainstaluj aplikację ntfy i wpisz ten kod jako temat:',
    regenerateTopic: 'Wygeneruj nowy kod',
  },
};

function detectLanguage() {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICTIONARIES[lang] ? lang : 'en';
}

const currentLanguage = detectLanguage();

export function t(key) {
  return DICTIONARIES[currentLanguage][key] ?? DICTIONARIES.en[key] ?? key;
}

export function getLanguage() {
  return currentLanguage;
}
