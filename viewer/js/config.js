// config.js — global constants, widget/tool options, branding defaults and allowed enrichment hosts.
const params = new URLSearchParams(location.search);

export const CONFIG = Object.freeze({
  schemaId: 'overstrand.map-manifest/3',
  storageKey: 'gis-orchestrator.v3',            // pre-projects storage (migrated on first run)
  projectsKey: 'gis-orchestrator.projects.v1',
  requestTimeoutMs: 20000,
  tokenMinutes: 120,          // how long a sign-in lasts

  manifestFile: params.get('manifest') || 'manifest.json',   // what a published viewer loads

  defaultPortalUrl: 'https://overstrand.maps.arcgis.com',
  // Created on first run, when the browser holds no projects yet. Set itemId to '' to start empty. manifest: the
  // viewer last saved in the repository by Sync; the first-run project takes it when it's there.
  defaultProject: { title: '', itemId: '', manifest: '' },
  identifyTolerancePx: 6,
  identifyMaxPerLayer: 10,
  sectionMaxRows: 200,
  spatialMaxRows: 1000,      // most rows per layer a spatial relationship section may ask for
  searchMaxResults: 200,
  logoMaxBytes: 150 * 1024,
  numberLocale: 'en-US',     // grouping/decimal style for numbers in Details: 205,000.00 like Experience Builder ('en-ZA' gives 205 000,00)

  // Details sections may only call these hosts. A leading dot allows subdomains.
  // Add your Minimal API host here (e.g. 'gisapi.example.gov').
  enrichmentHosts: ['.arcgis.com', location.hostname],

  // A sign-in's token goes only to its portal's own address (and ArcGIS Online's hosts for ArcGIS Online). List
  // ArcGIS Servers federated with a portal on another host here, e.g. { 'gisportal.example.gov': ['gisserver.example.gov'] }.
  federatedHosts: {},

  // Streaming (Cameras and Drones): sites an "embed" stream may be shown from, in a sandboxed frame. A leading dot allows subdomains.
  streamEmbedHosts: ['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com'],

  // External pages: the pages a new project starts with (and settings can add back). Fixed ids, so upgrading an older
  // manifest gives the same pages every time. Both are GIS viewers that open where the viewer's map is looking
  // (followMap): Cape Farm Mapper reads x, y and z from its address, and the CSG Property Viewer (Experience Builder)
  // a viewpoint for its map widget, widget_81.
  externalPageExamples: [
    { id: 'page-cfm', title: 'Cape Farm Mapper', url: 'https://gis.elsenburg.com/apps/cfm/#x={lon}&y={lat}&z={zoom}&bm=hybrid', followMap: true,
      description: 'Western Cape Department of Agriculture: farms, crops, soils and climate' },
    { id: 'page-csg', title: 'CSG Property Viewer', url: 'https://csggis.dlrrd.gov.za/portal/apps/experiencebuilder/experience/?id=a9a8f908e82c443b9cb7bede69f5985e#widget_81=viewpoint:%7B%22rotation%22%3A0%2C%22scale%22%3A{scale}%2C%22targetGeometry%22%3A%7B%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%2C%22x%22%3A{lon}%2C%22y%22%3A{lat}%7D%7D', followMap: true,
      description: 'Chief Surveyor-General (DLRRD): cadastral parcels and survey diagrams' }
  ],

  defaultBranding: {
    subtitle: '',
    headerBg: '#1C2B30',
    headerText: '#FFFFFF',
    accent: '#2B6F7F',
    selectionOnImagery: '#00E5FF',     // selection colour while an aerial / imagery layer is showing ('' = the accent)
    selectionLine: 'solid',            // the selection outline's line style (manifest.js SELECTION_LINES)
    logo: ''
  },

  // Order here is the order of the viewer's side rail.
  widgets: [
    ['layers', 'Layers'],
    ['legend', 'Legend'],
    ['layerInfo', 'Layer information'],
    ['details', 'Details'],
    ['bookmarks', 'Bookmarks'],
    ['search', 'Search'],
    ['addData', 'Add data'],
    ['dashboards', 'Dashboards'],
    ['editing', 'Editing'],
    ['scene', 'Scene'],
    ['streaming', 'Streaming'],
    ['externalPages', 'External pages'],
    ['downloads', 'Downloads'],
    ['trace', 'Attribute trace'],
    ['tools', 'Tools']
  ],

  // Dashboards: indicators, charts and tables built from web map layers (charts drawn with Chart.js, shipped in vendor/).
  // Widths and heights are grid columns and rows (dashboardItems.js).
  dashboardWidgetTypes: [
    ['indicator', 'Indicator (one number)'],
    ['bar', 'Bar chart'],
    ['hbar', 'Horizontal bar chart'],
    ['line', 'Line chart'],
    ['pie', 'Pie chart'],
    ['doughnut', 'Doughnut chart'],
    ['table', 'Summary table (one row per group)'],
    ['records', 'Features table (one row per feature)']
  ],
  dashboardStatistics: [['count', 'Count'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum']],
  dashboardLegend: [['auto', 'Automatic'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'Hidden']],
  dashboardColorModes: [['single', 'One colour'], ['palette', 'A colour per item']],
  dashboardSorts: [['value-desc', 'Largest first'], ['value-asc', 'Smallest first'], ['label-asc', 'By label (A–Z)']],
  tools: [
    ['measure-distance', 'Measure distance'],
    ['measure-area', 'Measure area'],
    ['select', 'Select features'],
    ['sketch', 'Draw'],
    ['swipe', 'Swipe'],
    ['elevation', 'Elevation profile'],
    ['label-orientation', 'Label orientation'],
    ['dimensions', 'Dimensions'],
    ['vegetation', 'Vegetation health'],
    ['go-to-xy', 'Go to coordinates'],
    ['address-audit', 'Address audit'],
    ['basemap-gallery', 'Basemap gallery'],
    ['print', 'Print'],
    ['share-link', 'Share link'],
    ['screenshot', 'Screenshot'],
    ['coordinates', 'Pointer coordinates'],
    ['export-results', 'Export results (Excel, CSV)']
  ],
  // Esri icon font classes for each tool (the font ships in the SDK's main.css, already loaded by both pages).
  toolIcons: {
    'measure-distance': 'esri-icon-measure-line',
    'measure-area':     'esri-icon-measure-area',
    'select':           'esri-icon-cursor-marquee',
    'sketch':           'esri-icon-edit',
    'swipe':            'esri-icon-swap',
    'elevation':        'esri-icon-elevation-profile',
    'label-orientation': 'esri-icon-labels',
    'dimensions':       'esri-icon-measure',
    'vegetation':       'esri-icon-chart',
    'go-to-xy':         'esri-icon-map-pin',
    'address-audit':    'esri-icon-checkbox-checked',
    'basemap-gallery':  'esri-icon-basemap',
    'print':            'esri-icon-printer',
    'share-link':       'esri-icon-share',
    'screenshot':       'esri-icon-media',
    'coordinates':      'esri-icon-cursor',
    'export-results':   'esri-icon-download'
  },
  // Tools that change map behaviour rather than opening a panel of their own.
  passiveTools: ['coordinates', 'export-results'],
  dimensionsMaxFeatures: 500,   // most features per layer the Dimensions tool measures in one view (more: zoom in)

  toolDefaults: {
    'measure-distance': { unit: 'metric' },
    'measure-area':     { unit: 'metric' },
    'select':           { layers: [], shapes: ['rectangle', 'polygon'] },
    'sketch':           { shapes: ['point', 'polyline', 'polygon', 'rectangle', 'circle'], color: '#2B6F7F' },
    'elevation':        { unit: 'metric' },
    'swipe':            { direction: 'horizontal', leading: [], trailing: [] },
    // Layer keys and field names are starting choices: people can pick other layers (and added data) in the tool.
    'label-orientation': { streetLayer: '', streetLabelField: '', pointLayer: '', labelField: '', angleField: '', saveGroupId: '', mode: 'PARALLEL', autoFlip: true },
    // People tick the layers to measure in the viewer. Each kind of label (lengths, areas, bearings) has its own colour.
    'dimensions':       { unit: 'meters', areaUnit: 'auto', decimals: 2, showArea: true, showBearings: false, bearingFormat: 'dms', lineLength: 'segments', lengthColor: '#000000', areaColor: '#000000', bearingColor: '#000000' },
    // Health from a multispectral ImageServer's bands (see vegetation.js; equals vegetationDefaults()). bands, scale and
    // the date/cloud fields are only used with source 'service'; the Sentinel-2 and Landsat presets bring their own.
    'vegetation':       { source: 'sentinel2', serviceUrl: '', bands: { blue: null, green: null, red: null, nir: null, swir1: null, swir2: null }, scale: 1,
                          dateField: '', cloudField: '', indices: ['ndvi', 'savi', 'ndmi', 'evi', 'nbr'], defaultIndex: 'ndvi', breaks: {}, maxCloud: 20, opacity: 0.7 },
    'go-to-xy':         { zoom: 17 },
    'basemap-gallery':  { basemaps: ['topo-vector', 'streets-vector', 'gray-vector', 'dark-gray-vector', 'satellite', 'hybrid', 'osm'] },
    'print':            { serviceUrl: 'https://utility.arcgisonline.com/arcgis/rest/services/Utilities/PrintingTools/GPServer/Export%20Web%20Map%20Task', title: '', layout: 'a4-landscape', format: 'pdf' },
    'share-link':       {},
    'screenshot':       { format: 'png' },
    'coordinates':      { format: 'dd' },
    'export-results':   {}
  },
  distanceUnits: [['metric', 'Metric (m / km)'], ['meters', 'Metres'], ['kilometers', 'Kilometres'], ['imperial', 'Imperial'], ['feet', 'Feet'], ['miles', 'Miles']],
  areaUnits: [['metric', 'Metric (m² / km²)'], ['square-meters', 'Square metres'], ['hectares', 'Hectares'], ['square-kilometers', 'Square kilometres'], ['imperial', 'Imperial'], ['acres', 'Acres']],
  swipeDirections: [['horizontal', 'Left and right'], ['vertical', 'Top and bottom']],
  selectShapes: [['rectangle', 'Rectangle'], ['polygon', 'Polygon'], ['circle', 'Circle'], ['point', 'Point']],
  sketchShapes: [['point', 'Point'], ['polyline', 'Line'], ['polygon', 'Polygon'], ['rectangle', 'Rectangle'], ['circle', 'Circle']],
  printLayouts: [['a4-landscape', 'A4 landscape'], ['a4-portrait', 'A4 portrait'], ['a3-landscape', 'A3 landscape'], ['a3-portrait', 'A3 portrait'], ['map-only', 'Map only']],
  printFormats: [['pdf', 'PDF'], ['png32', 'PNG'], ['jpg', 'JPG']],
  screenshotFormats: [['png', 'PNG (sharp, larger file)'], ['jpg', 'JPG (smaller file)']],
  basemaps: [
    ['topo-vector', 'Topographic'], ['streets-vector', 'Streets'], ['gray-vector', 'Light grey'], ['dark-gray-vector', 'Dark grey'],
    ['satellite', 'Imagery'], ['hybrid', 'Imagery with labels'], ['osm', 'OpenStreetMap']
  ],

  // Add data: portal item types people can add (Layer.fromPortalItem loads each of these in a 2D map).
  addDataItemTypes: ['Feature Service', 'Map Service', 'Image Service', 'Vector Tile Service', 'WMS', 'WFS', 'OGCFeatureServer', 'KML', 'CSV', 'GeoJson'],
  addDataPortalSearch: [['organization', "This organisation's items"], ['all', 'Everything the portal shows'], ['off', 'Off']],
  addDataPageSize: 20,
  addDataMaxFileBytes: 10 * 1024 * 1024,    // local files; zipped shapefiles are converted by the portal

  templates: [
    ['rail', 'Side rail', 'Widget icons in a rail beside the panel.'],
    ['header', 'Header bar', 'Widget buttons in the header; the panel docks to the side.'],
    ['floating', 'Header + floating panel', 'Widget buttons in the header; the panel floats over a full-width map.']
  ],

  // ?center=lon,lat&zoom=z (written by the Share link tool)
  startView: (() => {
    const c = params.get('center')?.split(',').map(Number);
    const z = Number(params.get('zoom'));
    return c?.length === 2 && c.every(Number.isFinite) && Number.isFinite(z) ? { center: c, zoom: z } : null;
  })()

});
