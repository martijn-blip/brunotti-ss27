/**
 * BRUNOTTI SS27 — Google Apps Script backend
 * ============================================
 * VERSIE 6 juli 2026 — volledige vervanging van het vorige script.
 * Alles van de vorige versie zit erin, plus twee nieuwe onderdelen:
 *
 *  NIEUW 1. "BI_Export"-tab in de Google Sheet: platte, Power BI-klare
 *     dataset (zelfde 29 kolommen als de "Power BI CSV"-download in de
 *     app), automatisch herschreven bij elke sync. Power BI leest deze
 *     tab via Get data → Web / Google Sheets en ververst dan vanzelf.
 *
 *  NIEUW 2. "?action=meta" endpoint: superlicht antwoord (alleen
 *     savedAt/savedBy/version) voor de conflict-check van de auto-sync,
 *     zodat niet telkens de complete dataset gedownload hoeft te worden.
 *     De metadata wordt bij elke save gecachet in Script Properties,
 *     dus dit endpoint hoeft niet eens Drive te lezen.
 *
 * Fixes the "folder.getFilesByMimeType is not a function" crash by no
 * longer searching folders at all. Instead, every file ID (backup JSON,
 * the live Sheet) is stored in Script Properties on first run, so every
 * later save/load just opens that ID directly — fast and can't break.
 *
 * WHAT THIS DOES ON EVERY SYNC ("Synchroniseren met team" in de app):
 *  1. Overwrites "brunotti_ss27_latest.json" (source of truth used to
 *     restore into the app / used by "load").
 *  2. Writes a timestamped backup copy into a "Backups" subfolder
 *     (keeps the most recent 30, older ones are auto-deleted).
 *  3. Rewrites one Google Sheet with a tab per data category:
 *       - "SS27 Data"    — alle artikelen, met marge-kleurcodering
 *       - "Leveranciers", "Kleuren", "Stoffen", "HS Codes", "Pasvorm"
 *         — de stamdata, elk in hun eigen tabblad
 *       - "BI_Export"    — platte Power BI-dataset (NIEUW)
 *       - "Sync Info"    — details van de laatste sync
 *       - "Log"          — append-only geschiedenis, nieuwste bovenaan:
 *         wie heeft wanneer wat gesynchroniseerd (aantallen per categorie)
 *
 * VERSIEBEHEER: er wordt bewust geen extra Apps Script "Advanced Service"
 * gebruikt. Google Sheets heeft standaard al ingebouwde versiegeschiedenis
 * (Bestand > Versiegeschiedenis in de Sheet zelf) die elke wijziging
 * bijhoudt — dat is voldoende bij een synchronisatiefrequentie van een
 * paar keer per week, en vraagt geen enkele extra installatiestap.
 *
 * INSTALLATIE VAN DEZE UPDATE (bestaand project):
 *  1. script.google.com -> open je bestaande Brunotti-project.
 *  2. Selecteer ALLE bestaande code en vervang die door dit hele bestand.
 *  3. Deploy -> Manage deployments (Implementaties beheren) -> potloodje
 *     bij de bestaande implementatie -> Version: "New version" -> Deploy.
 *     BELANGRIJK: de bestaande implementatie bijwerken, GEEN nieuwe
 *     aanmaken — dan blijft de URL hetzelfde en hoeft er in de app niets
 *     te veranderen.
 *  4. Klaar. Bij de eerstvolgende sync verschijnt de BI_Export-tab
 *     vanzelf in de Sheet, en schakelt de auto-sync automatisch over
 *     op het lichte meta-endpoint.
 */

var ROOT_FOLDER_NAME = 'Brunotti SS27 Sync';
var LATEST_FILE_NAME = 'brunotti_ss27_latest.json';
var SHEET_FILE_NAME = 'Brunotti SS27 Data';
var BACKUPS_FOLDER_NAME = 'Backups';
var MAX_BACKUPS = 30;

var PROPS = PropertiesService.getScriptProperties();

// ── Entry Point: GET (load / meta) ───────────────────────────
function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (action === 'meta') {
      return loadMeta_();
    }
    if (action === 'load') {
      return loadLatest_();
    }
    return jsonResponse_({ status: 'error', error: 'Unknown action' });
  } catch (err) {
    return jsonResponse_({ status: 'error', error: String(err) });
  }
}

// ── Entry Point: POST (save) ─────────────────────────────────
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'save') {
      return saveLatest_(body.payload);
    }
    return jsonResponse_({ status: 'error', error: 'Unknown action' });
  } catch (err) {
    return jsonResponse_({ status: 'error', error: String(err) });
  }
}

// ── Save ──────────────────────────────────────────────────────
function saveLatest_(payload) {
  var latestFile = getOrCreateLatestFile_();
  latestFile.setContent(JSON.stringify(payload));

  // NIEUW: metadata cachen zodat ?action=meta razendsnel en zonder
  // Drive-toegang kan antwoorden (gebruikt door de auto-sync in de app).
  PROPS.setProperty('LAST_META', JSON.stringify({
    savedAt: payload.savedAt || null,
    savedBy: payload.savedBy || null,
    version: payload.version || null
  }));

  writeBackupCopy_(payload);

  var sheetUrl = rebuildSheet_(payload);

  return jsonResponse_({
    status: 'ok',
    entries: (payload.entries || []).length,
    sheetUrl: sheetUrl
  });
}

// ── Load ──────────────────────────────────────────────────────
function loadLatest_() {
  var fileId = PROPS.getProperty('LATEST_FILE_ID');
  if (!fileId) {
    return jsonResponse_({ status: 'empty' });
  }
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    return jsonResponse_({ status: 'empty' });
  }
  var content = file.getBlob().getDataAsString();
  var data = JSON.parse(content);
  data.status = 'ok';
  var sheetId = PROPS.getProperty('SHEET_FILE_ID');
  if (sheetId) {
    data.sheetUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit';
  }
  return jsonResponse_(data);
}

// ── NIEUW: Meta (licht antwoord voor de auto-sync conflict-check) ──
function loadMeta_() {
  // Snelste route: gecachete metadata uit Script Properties.
  var cached = PROPS.getProperty('LAST_META');
  if (cached) {
    try {
      var meta = JSON.parse(cached);
      meta.status = 'ok';
      return jsonResponse_(meta);
    } catch (err) {
      // cache onleesbaar — val terug op het bestand hieronder
    }
  }
  // Fallback (eerste keer na deze update, vóór de eerstvolgende save):
  // lees het latest-bestand en beantwoord alleen de metadata.
  var fileId = PROPS.getProperty('LATEST_FILE_ID');
  if (!fileId) {
    return jsonResponse_({ status: 'empty' });
  }
  try {
    var file = DriveApp.getFileById(fileId);
    var data = JSON.parse(file.getBlob().getDataAsString());
    return jsonResponse_({
      status: 'ok',
      savedAt: data.savedAt || null,
      savedBy: data.savedBy || null,
      version: data.version || null
    });
  } catch (err) {
    return jsonResponse_({ status: 'empty' });
  }
}

// ── Root folder (created once, ID cached) ────────────────────
function getOrCreateRootFolder_() {
  var folderId = PROPS.getProperty('ROOT_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (err) {
      // fall through and recreate if it was deleted
    }
  }
  var folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  PROPS.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateBackupsFolder_() {
  var folderId = PROPS.getProperty('BACKUPS_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (err) {
      // fall through
    }
  }
  var root = getOrCreateRootFolder_();
  var folder = root.createFolder(BACKUPS_FOLDER_NAME);
  PROPS.setProperty('BACKUPS_FOLDER_ID', folder.getId());
  return folder;
}

// ── Latest JSON file (created once, ID cached) ───────────────
function getOrCreateLatestFile_() {
  var fileId = PROPS.getProperty('LATEST_FILE_ID');
  if (fileId) {
    try {
      return DriveApp.getFileById(fileId);
    } catch (err) {
      // fall through and recreate
    }
  }
  var root = getOrCreateRootFolder_();
  var file = root.createFile(LATEST_FILE_NAME, '{}', MimeType.PLAIN_TEXT);
  PROPS.setProperty('LATEST_FILE_ID', file.getId());
  return file;
}

// ── Timestamped backup copy, with cleanup of old ones ────────
function writeBackupCopy_(payload) {
  var backups = getOrCreateBackupsFolder_();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd_HH-mm-ss');
  backups.createFile('backup_' + stamp + '.json', JSON.stringify(payload), MimeType.PLAIN_TEXT);

  // Keep only the most recent MAX_BACKUPS files
  var files = backups.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    list.push({ file: f, created: f.getDateCreated().getTime() });
  }
  list.sort(function (a, b) { return b.created - a.created; });
  for (var i = MAX_BACKUPS; i < list.length; i++) {
    list[i].file.setTrashed(true);
  }
}

// ── Sheet (created once, ID cached; content fully rewritten) ─
function getOrCreateSheet_() {
  var sheetId = PROPS.getProperty('SHEET_FILE_ID');
  if (sheetId) {
    try {
      return SpreadsheetApp.openById(sheetId);
    } catch (err) {
      // fall through and recreate
    }
  }
  var root = getOrCreateRootFolder_();
  var ss = SpreadsheetApp.create(SHEET_FILE_NAME);
  var file = DriveApp.getFileById(ss.getId());
  root.addFile(file);
  DriveApp.getRootFolder().removeFile(file); // move out of "My Drive" root, keep only in our folder
  PROPS.setProperty('SHEET_FILE_ID', ss.getId());
  return ss;
}

var COLUMNS = [
  { key: 'styleNumber', label: 'Style Number' },
  { key: 'styleName', label: 'Style Name' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'collectieGroep', label: 'Collectiegroep' },
  { key: 'group', label: 'Group' },
  { key: 'subgroup', label: 'Subgroup' },
  { key: 'quality', label: 'Kwaliteit/Stof' },
  { key: 'segment', label: 'Segment' },
  { key: 'colorSeq', label: 'Color Seq' },
  { key: 'colourNumber', label: 'Colour Number' },
  { key: 'colourName', label: 'Colour Name' },
  { key: 'fobCost', label: 'FOB Cost' },
  { key: 'supplierQuote1', label: 'Supplier Quote 1' },
  { key: 'supplierQuote2', label: 'Supplier Quote 2' },
  { key: 'lastPurchasePrice', label: 'Last Purchase Price' },
  { key: 'moq', label: 'MOQ' },
  { key: 'retailEuro', label: 'Retail EUR' },
  { key: 'vvpEuro', label: 'VVP EUR' },
  { key: 'actualMargin', label: 'Margin %', isPercent: true },
  { key: 'samplePrice', label: 'Sample Price' },
  { key: 'sampleQty', label: 'Sample Qty' },
  { key: 'status', label: 'Status' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'savedAt', label: 'Saved At' }
];

// Zelfde kolomdefinities als de STAMDATA_COLUMNS in de app zelf (index.html),
// bewust gescheiden gehouden omdat Apps Script en de browser-app niet
// dezelfde code kunnen delen — bij toekomstige veldwijzigingen in de app,
// hier ook bijwerken.
var MASTERDATA_SHEETS = [
  {
    tabName: 'Leveranciers',
    dataKey: 'vendors',
    columns: [
      { key: 'name', label: 'Naam' }, { key: 'code', label: 'Code' },
      { key: 'country', label: 'Land' }, { key: 'currency', label: 'Valuta' },
      { key: 'importFactor', label: 'Import factor' }, { key: 'currencyFactor', label: 'FX factor' },
      { key: 'comFee', label: 'Com. Fee' }, { key: 'samplingFOB', label: 'Sample FOB' },
      { key: 'notes', label: 'Notes' }
    ]
  },
  {
    tabName: 'Kleuren',
    dataKey: 'colours',
    columns: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Naam' },
      { key: 'pantone', label: 'Pantone' }, { key: 'fedas', label: 'Fedas' }
    ]
  },
  {
    tabName: 'Stoffen',
    dataKey: 'fabrics',
    columns: [
      { key: 'quality', label: 'Kwaliteit' }, { key: 'composition', label: 'Samenstelling' },
      { key: 'weight', label: 'Gewicht' }, { key: 'supplier', label: 'Leverancier' },
      { key: 'fabricCode', label: 'Fabric Code' }, { key: 'type', label: 'Type' },
      { key: 'remark', label: 'Opmerking' }
    ]
  },
  {
    tabName: 'HS Codes',
    dataKey: 'hsCodes',
    columns: [
      { key: 'code', label: 'HS Code' }, { key: 'descNL', label: 'NL omschrijving' },
      { key: 'descEN', label: 'EN omschrijving' }, { key: 'category', label: 'Categorie' },
      { key: 'weight', label: 'Gewicht (kg)' }
    ]
  },
  {
    tabName: 'Pasvorm',
    dataKey: 'fits',
    columns: [
      { key: 'no', label: 'Nummer' }, { key: 'name', label: 'Naam' }
    ]
  }
];

var LOG_SHEET_NAME = 'Log';
var MAX_LOG_ROWS = 1000;

function rebuildSheet_(payload) {
  var ss = getOrCreateSheet_();
  var sheet = ss.getSheets()[0];
  sheet.clear();
  sheet.setName('SS27 Data');

  // Header
  var headers = COLUMNS.map(function (c) { return c.label; });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#1D9E75')
    .setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);

  var entries = payload.entries || [];
  if (entries.length > 0) {
    var rows = entries.map(function (entry) {
      return COLUMNS.map(function (c) {
        var v = entry[c.key];
        if (v === undefined || v === null) return '';
        return v;
      });
    });
    var range = sheet.getRange(2, 1, rows.length, headers.length);
    range.setValues(rows);

    // Format margin column as percentage
    var marginColIndex = COLUMNS.findIndex(function (c) { return c.key === 'actualMargin'; }) + 1;
    if (marginColIndex > 0) {
      var marginRange = sheet.getRange(2, marginColIndex, rows.length, 1);
      marginRange.setNumberFormat('0.0%');

      // Conditional formatting: green >=42%, orange 35-42%, red <35%
      sheet.clearConditionalFormatRules();
      var rules = [];
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThanOrEqualTo(0.42)
        .setBackground('#d9f2e6')
        .setRanges([marginRange])
        .build());
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberBetween(0.35, 0.4199)
        .setBackground('#fdecd2')
        .setRanges([marginRange])
        .build());
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberLessThan(0.35)
        .setBackground('#fbdcd8')
        .setRanges([marginRange])
        .build());
      sheet.setConditionalFormatRules(rules);
    }

    sheet.autoResizeColumns(1, headers.length);
  }

  // Info row: last sync details, placed on a second sheet tab
  var infoSheetName = 'Sync Info';
  var infoSheet = ss.getSheetByName(infoSheetName);
  if (!infoSheet) {
    infoSheet = ss.insertSheet(infoSheetName);
  }
  infoSheet.clear();
  infoSheet.getRange(1, 1, 4, 2).setValues([
    ['Last saved at', payload.savedAt || ''],
    ['Saved by', payload.savedBy || ''],
    ['App version', payload.version || ''],
    ['Entry count', entries.length]
  ]);
  infoSheet.autoResizeColumns(1, 2);

  // Stamdata-categorieën als eigen tabs — altijd volledig herschreven,
  // net als de hoofd-tab, zodat ze nooit uit sync raken.
  MASTERDATA_SHEETS.forEach(function (cat) {
    var data = (payload.masterData && payload.masterData[cat.dataKey]) || [];
    var catSheet = ss.getSheetByName(cat.tabName);
    if (!catSheet) catSheet = ss.insertSheet(cat.tabName);
    catSheet.clear();
    var catHeaders = cat.columns.map(function (c) { return c.label; });
    catSheet.getRange(1, 1, 1, catHeaders.length).setValues([catHeaders]);
    catSheet.getRange(1, 1, 1, catHeaders.length)
      .setFontWeight('bold').setBackground('#1D9E75').setFontColor('#FFFFFF');
    catSheet.setFrozenRows(1);
    if (data.length > 0) {
      var catRows = data.map(function (item) {
        return cat.columns.map(function (c) {
          var v = item[c.key];
          return (v === undefined || v === null) ? '' : v;
        });
      });
      catSheet.getRange(2, 1, catRows.length, catHeaders.length).setValues(catRows);
      catSheet.autoResizeColumns(1, catHeaders.length);
    }
  });

  // NIEUW: platte Power BI-dataset als eigen tab.
  writeBiExportTab_(ss, payload);

  // Log-tab: append-only geschiedenis van elke sync. Puur SpreadsheetApp,
  // vraagt geen extra rechten of Advanced Services. Nieuwste bovenaan.
  appendLogEntry_(ss, payload, entries.length);

  return 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit';
}

// ── NIEUW: BI_Export-tab ─────────────────────────────────────
// Platte, Power BI-klare dataset: één rij per stijl+kleur, vaste
// sleutelkolom, stabiele Engelse kolomnamen, getallen als échte
// getallen. Exact dezelfde 29 kolommen als de "Power BI CSV"-download
// in de app (menu Export) — bij wijzigingen daar, hier ook bijwerken.
function writeBiExportTab_(ss, payload) {
  var HEADERS = ['key', 'style_number', 'style_name', 'season', 'vendor', 'collection_group',
    'product_group', 'subgroup', 'quality', 'segment', 'color_seq', 'colour_number', 'colour_name',
    'size_range', 'fabric_name', 'composition', 'fob_cost', 'supplier_quote_1',
    'last_purchase_price', 'moq', 'wholesale_euro', 'vvp_euro', 'retail_euro',
    'target_margin', 'actual_margin', 'status', 'saved_at', 'updated_at', 'exported_at'];

  var num = function (v) {
    return (v === null || v === undefined || v === '' || isNaN(v)) ? '' : Number(v);
  };
  var txt = function (v) {
    return (v === null || v === undefined) ? '' : String(v);
  };

  var now = new Date().toISOString();
  var entries = payload.entries || [];
  var rows = entries.map(function (e) {
    var si = (e.collectie && e.collectie.styleInfo) || {};
    return [
      txt(e.styleNumber) + '_' + txt(e.colourNumber),
      txt(e.styleNumber), txt(e.styleName), txt(e.season || 'SS27'),
      txt(e.vendor), txt(e.collectieGroep), txt(e.group), txt(e.subgroup),
      txt(e.quality), txt(e.segment),
      num(e.colorSeq), txt(e.colourNumber), txt(e.colourName),
      txt(si.sizeRange), txt(si.fabricName), txt(si.compositionShell),
      num(e.fobCost), num(e.supplierQuote1), num(e.lastPurchasePrice), num(e.moq),
      num(e.wholesale), num(e.vvpEuro), num(e.retailEuro),
      num(e.targetMargin), num(e.actualMargin),
      txt(e.status), txt(e.savedAt), txt(e.updatedAt), now
    ];
  });

  var sh = ss.getSheetByName('BI_Export') || ss.insertSheet('BI_Export');
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }
  sh.setFrozenRows(1);
  // Bewust geen autoResizeColumns of opmaak: dit tabblad is voor
  // machines (Power BI), niet voor mensen — scheelt synctijd.
}

function appendLogEntry_(ss, payload, entryCount) {
  var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(LOG_SHEET_NAME);
    var logHeaders = ['Datum/tijd', 'Door', 'App versie', 'Artikelen', 'Leveranciers', 'Kleuren', 'Stoffen', 'HS Codes', 'Pasvorm'];
    logSheet.getRange(1, 1, 1, logHeaders.length).setValues([logHeaders]);
    logSheet.getRange(1, 1, 1, logHeaders.length)
      .setFontWeight('bold').setBackground('#1D9E75').setFontColor('#FFFFFF');
    logSheet.setFrozenRows(1);
  }

  var newRow = [
    payload.savedAt ? new Date(payload.savedAt) : new Date(),
    payload.savedBy || 'onbekend',
    payload.version || '',
    entryCount,
    (payload.masterData && payload.masterData.vendors || []).length,
    (payload.masterData && payload.masterData.colours || []).length,
    (payload.masterData && payload.masterData.fabrics || []).length,
    (payload.masterData && payload.masterData.hsCodes || []).length,
    (payload.masterData && payload.masterData.fits || []).length
  ];

  // Nieuwste bovenaan: rij invoegen direct na de header.
  logSheet.insertRowAfter(1);
  logSheet.getRange(2, 1, 1, newRow.length).setValues([newRow]);
  logSheet.getRange(2, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  // Log niet onbeperkt laten groeien.
  var lastRow = logSheet.getLastRow();
  if (lastRow > MAX_LOG_ROWS + 1) {
    logSheet.deleteRows(MAX_LOG_ROWS + 2, lastRow - MAX_LOG_ROWS - 1);
  }
  logSheet.autoResizeColumns(1, newRow.length);
}

// ── One-off: run this manually from the editor to trigger the
// Google consent screen for Sheets access. Creates and immediately
// deletes a test spreadsheet — safe to run.
function authorizeSheetsAccess() {
  var testSheet = SpreadsheetApp.create('Brunotti SS27 - auth test (safe to delete)');
  DriveApp.getFileById(testSheet.getId()).setTrashed(true);
  Logger.log('Sheets access authorized successfully.');
}

// ── Helpers ───────────────────────────────────────────────────
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
