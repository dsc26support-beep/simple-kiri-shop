// ============================================================================
// Island/village list reviewed and corrected by the store owner (a Kiribati
// local) on 2026-08-29. Each array is a plain list of village-name strings.
// Every island automatically gets an "Other (please specify)" option appended
// in code (see owner-settings.js), so a customer/vendor is never blocked by a
// missing village name.
//
// NOTE: the island NAMES 'South Tarawa' and 'North Tarawa', and the North
// Tarawa villages 'Buota'/'Abatao'/'Tabiteuea', are load-bearing in the
// delivery-eligibility logic (checkout.js, Orders.gs). Don't rename them
// without updating that logic to match.
// ============================================================================
const KIRIBATI_ISLANDS = {
  'South Tarawa': ['Betio', 'Bairiki', 'Nanikai', 'Teaoraereke', 'Antebuka', 'Banraeaba', 'Ambo', 'Taborio', 'Eita', 'Abarao', 'Bikenibeu', 'Bonriki', 'Marae', 'Kawaiaeboou', 'Temaiku'],
  'North Tarawa': ['Buariki', 'Abatao', 'Marenanuka', 'Tearinibai', 'Nabeina', 'Taratai', 'Nooto', 'Abaokoro', 'Buota', 'Tabiteuea'],
  Makin: ['Makin', 'Kiebu'],
  Butaritari: ['Ukiangang', 'Onomwaru', 'Temwanokunuea', 'Vatikano', 'Antekana', 'Taboniuea', 'Tanimaiaki', 'Tanimainiku', 'Keuea', 'Kuma'],
  Marakei: ['Rawannawi', 'Temotu', 'Buota', 'Tekarakan', 'Bwainuna', 'Norauea', 'Tekuanga', 'Antai'],
  Abaiang: ['Takarano', 'Aonibuaka', 'Borotiam', 'Koinawa', 'Morikao', 'Ewena', 'Taburao', 'Tebero', 'Tabwiroa', 'Tuarabu', 'Teirio', 'Tanimaiaki', 'Taniau', 'Tabontebike', 'Nuotaea'],
  Maiana: ['Bubutei', 'Tebanga', 'Raweai', 'Tebiauea', 'Tematantongo', 'Tekaranga', 'Tebangetua', 'Temwangaua', 'Toora', 'Aobike', 'Tebikerai', 'Teitai'],
  Kuria: ['Oneke', 'Marenaua', 'Buariki'],
  Aranuka: ['Takaeang', 'Buariki', 'Kauake', 'Baurua'],
  Abemama: ['Tabiang', 'Tekatirirake', 'Kabangaki', 'Bangotantekabaia', 'Baretoa', 'Tabontebike', 'Manoku', 'Tebanga', 'Abatiku', 'Kauma', 'Kariatebike'],
  Nonouti: ['Abamakoro', 'Matang', 'Rotima', 'Teuabu', 'Temanoku', 'Temotu', 'Autukia', 'Mwakauro', 'Taboiaki', 'Benuaroa'],
  'Tabiteuea North': ['Eita', 'Utiroa', 'Tanaeang', 'Buariki', 'Buota', 'Terikiai', 'Tekaman', 'Kabuna', 'Tauma', 'Aiwa', 'Tekabwibwi', 'Tenatorua', 'Bangai'],
  'Tabiteuea South': ['Tewai', 'Betarawa', 'Buariki', 'Taungaeaka', 'Nikutoru', 'Katabanga', 'Taku'],
  Beru: ['Taboiaki', 'Eriko', 'Taubukiniberu', 'Teteirio', 'Nuka', 'Rongorongo', 'Aoniman', 'Autukia', 'Tabiang'],
  Nikunau: ['Muribenua', 'Tabutoa', 'Rungata', 'Manriki', 'Nikumanu', 'Tabomatang'],
  Onotoa: ['Tekawa', 'Tanaeang', 'Buariki', 'Temao', 'Otoae', 'Aiaki', 'Tabuarorae'],
  Tamana: ['Bakaka', 'Barebuka', 'Bakarawa'],
  Arorae: ['Roreti', 'Tamaroa', 'Taribo'],
  Banaba: ['Tabwewa', 'Tabiang', 'Umwa', 'Buakonikai'],
  Kiritimati: ['Banana', 'Poland', 'Tabwakea', 'London'],
  Tabuaeran: ['Paelau', 'Tereitaki', 'Betania', 'Eten', 'Terine', 'Fareturaina', 'Aontenaa', 'Napari', 'Aramari'],
  Teraina: ['Tangkore', 'Matanibike', 'Arabata', 'Onouea', 'Kauamwemwe', 'Mwakeitari', 'Abaiang', 'Uteute', 'Tekaitara'],
  Kanton: ['Tebaronga', 'Tabon te Uaabu']
};

const KIRIBATI_OTHER_VILLAGE = 'Other (please specify)';
