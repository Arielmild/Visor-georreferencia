const C = globalThis.Cesium;
const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fields = {
  orientacion: [0, 360],
  altitud_relativa_m: [-10000, 10000],
  este_m: [-10000, 10000],
  norte_m: [-10000, 10000],
};
const storageKey = "providencia-cesium-ajustes-v2";
const labels = { paralelo: "Paralelo", frente: "De frente" };
const normalizedText = (text) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function validValues(values) {
  return Object.entries(fields).every(([key, [min, max]]) =>
    Number.isFinite(values?.[key]) && values[key] >= min && values[key] <= max);
}

async function main() {
  if (!C) throw new Error("Cesium no se pudo descargar. Comprueba la conexión y recarga.");
  async function readJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`No se pudo leer ${path}.`);
    return response.json();
  }
  const [{ modo, estaciones }, catalogo] = await Promise.all([
    readJson("./ubicaciones.json"), readJson("./assets/modelos.json"),
  ]);
  if (!estaciones.length || estaciones.some((site) =>
    !site.modelos.length || site.modelos.some((key) => !Object.hasOwn(catalogo, key)))) {
    throw new Error("El catálogo y las configuraciones de las ubicaciones no coinciden.");
  }
  const sites = new Map(estaciones.map((site) => [site.id, site]));
  const overrides = new Map();
  const choices = new Map();
  const local = readStored(storageKey);
  const legacy = readStored("providencia-cesium-ajustes-v1");
  const adjustmentKey = (site, variant) => `${site.id}/${variant}`;
  for (const site of estaciones) {
    const saved = local.variantes?.[site.id];
    if (site.modelos.includes(saved)) choices.set(site.id, saved);
    for (const variant of site.modelos) {
      const key = adjustmentKey(site, variant);
      const previous = variant === "paralelo" && !local.ajustes ? legacy[site.id] : undefined;
      const adjustment = local.ajustes?.[key] ?? previous;
      if (validValues(adjustment)) overrides.set(key, adjustment);
    }
  }
  const linkedSite = sites.get(params.get("sitio"));
  const linkedVariant = params.get("modelo");
  if (linkedSite) {
    if (linkedSite.modelos.includes(linkedVariant)) choices.set(linkedSite.id, linkedVariant);
    try {
      const linked = JSON.parse(params.get("ajuste"));
      const variant = linkedSite.modelos.includes(linkedVariant) ? linkedVariant : linkedSite.modelos[0];
      const compatibleLink = linkedVariant === null || linkedVariant === "original" ||
        linkedSite.modelos.includes(linkedVariant);
      if (compatibleLink && validValues(linked)) overrides.set(adjustmentKey(linkedSite, variant), linked);
    } catch {
      // Se puede abrir una ubicación aunque el enlace contenga ajustes inválidos.
    }
  }
  const variantOf = (site) => choices.get(site.id) ?? site.modelos[0];
  const values = (site) => overrides.get(adjustmentKey(site, variantOf(site))) ?? site.ajuste;
  const status = (message) => { el("estado").textContent = message; };
  C.Ion.defaultAccessToken = undefined;

  const viewer = new C.Viewer("globo", {
    baseLayer: false, baseLayerPicker: false, animation: false, timeline: false,
    homeButton: false, geocoder: false, navigationHelpButton: false, sceneModePicker: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
    requestRenderMode: true, maximumRenderTimeChange: Infinity,
  });
  const scene = viewer.scene;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.baseColor = C.Color.fromCssColorString("#293e37");
  const controller = scene.screenSpaceCameraController;
  controller.minimumZoomDistance = 2;

  const pins = new Map(estaciones.map((site) => [
    site.id,
    viewer.entities.add({
      id: site.id,
      position: C.Cartesian3.fromDegrees(site.referencia.longitud, site.referencia.latitud),
      point: {
        pixelSize: 11, color: C.Color.fromCssColorString(site.tipo === "plaza" ? "#9ed8ff" : "#b7eb87"),
        outlineColor: C.Color.BLACK,
        outlineWidth: 2, heightReference: C.HeightReference.CLAMP_TO_TERRAIN,
        disableDepthTestDistance: Infinity,
      },
    }),
  ]));
  const lons = estaciones.map((s) => s.referencia.longitud);
  const lats = estaciones.map((s) => s.referencia.latitud);
  const padding = modo === "prueba" ? 0.0010 : 0.004;
  const extent = C.Rectangle.fromDegrees(
    Math.min(...lons) - padding, Math.min(...lats) - padding,
    Math.max(...lons) + padding, Math.max(...lats) + padding,
  );
  const overviewCamera = C.Cartographic.fromCartesian(viewer.camera.getRectangleCameraCoordinates(extent));
  let overviewGround = 900;
  const overviewDestination = () => C.Cartesian3.fromRadians(
    overviewCamera.longitude, overviewCamera.latitude, overviewCamera.height + overviewGround,
  );
  const topDown = { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 };
  viewer.camera.setView({ destination: overviewDestination(), orientation: topDown });

  let selected;
  let detail = false;
  const modelos = new Map();
  let terrain;
  let flightVersion = 0;
  const form = el("ajustes");

  function placement(site) {
    const { longitud, latitud } = site.referencia;
    const adjustment = values(site);
    const model = catalogo[variantOf(site)];
    const frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(longitud, latitud));
    const horizontal = C.Matrix4.multiplyByPoint(
      frame, new C.Cartesian3(adjustment.este_m, adjustment.norte_m, 0), new C.Cartesian3(),
    );
    const coord = C.Cartographic.fromCartesian(horizontal);
    // Cesium convierte Y arriba a Z arriba. Conservamos +X como eje longitudinal.
    const origin = C.Cartesian3.fromRadians(
      coord.longitude, coord.latitude, adjustment.altitud_relativa_m - model.base_y_m,
    );
    const atSite = C.Transforms.eastNorthUpToFixedFrame(origin);
    const turn = C.Matrix3.fromRotationZ(C.Math.toRadians(model.rumbo_base_deg - adjustment.orientacion));
    const matrix = C.Matrix4.multiplyByMatrix3(atSite, turn, new C.Matrix4());
    return { matrix, coord, altitude: adjustment.altitud_relativa_m };
  }

  function requestModel(variant) {
    const entry = {};
    modelos.set(variant, entry);
    const url = new URL(catalogo[variant].archivo, location.href);
    function failed(error) {
      console.error(error);
      if (entry.model) scene.primitives.remove(entry.model);
      entry.model = undefined;
      entry.failed = true;
      updateModel();
    }
    C.Model.fromGltfAsync({
      url: url.href, scene, modelMatrix: placement(selected).matrix,
      heightReference: C.HeightReference.RELATIVE_TO_TERRAIN, scale: 1, minimumPixelSize: 0,
      enableVerticalExaggeration: false, upAxis: C.Axis.Y, forwardAxis: C.Axis.X,
      shadows: C.ShadowMode.DISABLED, allowPicking: false, show: false,
    }).then((loaded) => {
      entry.model = scene.primitives.add(loaded);
      loaded.readyEvent.addEventListener(updateModel);
      loaded.errorEvent.addEventListener(failed);
      updateModel();
    }).catch(failed);
  }

  function updateModel() {
    const active = detail && selected && el("modelos").checked;
    const variant = active ? variantOf(selected) : null;
    const current = modelos.get(variant);
    for (const [key, { model }] of modelos) {
      if (!model) continue;
      model.show = key === variant;
      if (model.show) model.modelMatrix = placement(selected).matrix;
    }
    if (!el("modelos").checked) status("Modelo 3D oculto.");
    else if (!active) status("Marcadores de referencia · selecciona una ubicación para verla en 3D.");
    else if (current?.model?.ready) status(`${selected.id} · ${labels[variant]} · ABB Terra · escala 1:1`);
    else if (current?.failed) status("Error al cargar el modelo. Vuelve a activar Modelo 3D para reintentar.");
    else {
      status(`Cargando modelo ${labels[variant].toLowerCase()}…`);
      if (!current) requestModel(variant);
    }
    scene.requestRender();
  }

  async function focus() {
    if (!selected) return;
    const current = ++flightVersion;
    detail = true;
    const { coord, altitude } = placement(selected);
    const radius = catalogo[variantOf(selected)].radio_m;
    const visibleHeight = scene.globe.getHeight(coord);
    function fly(height, duration) {
      const target = C.Cartesian3.fromRadians(coord.longitude, coord.latitude, height + altitude + 0.7);
      viewer.camera.flyToBoundingSphere(new C.BoundingSphere(target, radius), {
        offset: new C.HeadingPitchRange(C.Math.toRadians(30), C.Math.toRadians(-42), radius * 4.8),
        duration,
      });
    }
    updateModel();
    if (Number.isFinite(visibleHeight) || !terrain) fly(visibleHeight ?? 0, 0.85);
    if (!terrain) return;
    try {
      await C.sampleTerrain(terrain, 14, [coord]);
      if (current !== flightVersion) return;
      if (!Number.isFinite(visibleHeight) || Math.abs(coord.height - visibleHeight) > 8) {
        fly(coord.height ?? scene.globe.getHeight(coord) ?? overviewGround, 0.75);
      }
    } catch (error) {
      console.warn("Muestra de elevación", error);
      if (current === flightVersion && !Number.isFinite(visibleHeight)) {
        fly(scene.globe.getHeight(coord) ?? overviewGround, 0.85);
      }
    }
  }

  function overview() {
    ++flightVersion;
    detail = false;
    viewer.camera.flyTo({ destination: overviewDestination(), orientation: topDown, duration: 0.85 });
    updateModel();
  }

  function updatePosition() {
    const { coord } = placement(selected);
    el("posicion").textContent = "Modelo: " + coordinates(
      C.Math.toDegrees(coord.latitude), C.Math.toDegrees(coord.longitude),
    );
  }

  function coordinates(lat, lon) {
    return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }

  function populateForm() {
    const adjustment = values(selected);
    for (const key of Object.keys(fields)) form.elements.namedItem(key).value = adjustment[key];
    updatePosition();
  }

  function updateLink() {
    const variant = variantOf(selected);
    const url = new URL(location.href);
    url.searchParams.set("sitio", selected.id);
    url.searchParams.set("modelo", variant);
    url.searchParams.delete("ajuste");
    if (overrides.has(adjustmentKey(selected, variant))) {
      url.searchParams.set("ajuste", JSON.stringify(values(selected)));
    }
    history.replaceState(null, "", url);
  }

  function choose(variant) {
    choices.set(selected.id, variant);
    saveLocal();
    updateLink();
    drawVariants();
    populateForm();
    focus();
  }

  function drawVariants() {
    const controls = selected.modelos.map((variant) => {
      if (selected.modelos.length === 1) {
        const fixed = document.createElement("span");
        fixed.className = "variante-fija";
        fixed.textContent = labels[variant];
        return fixed;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = labels[variant];
      button.setAttribute("aria-pressed", String(variant === variantOf(selected)));
      button.addEventListener("click", () => {
        if (variant !== variantOf(selected)) {
          choose(variant);
          el("variantes").querySelector('[aria-pressed="true"]').focus();
        }
      });
      return button;
    });
    el("variantes").replaceChildren(...controls);
    const message = el("viabilidad");
    message.textContent = selected.motivo_modelos ?? (selected.tipo === "plaza"
      ? "Modelo de frente para la plaza. Emplazamiento preliminar."
      : "Comparación preliminar. El encaje depende del ancho disponible y del estacionamiento permitido.");
    if (selected.fuente_modelos) {
      const source = document.createElement("a");
      source.href = selected.fuente_modelos;
      source.textContent = "Ver referencia";
      source.target = "_blank";
      source.rel = "noopener";
      message.append(" ", source);
    }
  }

  function select(site) {
    if (selected) pins.get(selected.id).point.pixelSize = 11;
    selected = site;
    pins.get(site.id).point.pixelSize = 17;
    updateLink();
    el("ficha").hidden = false;
    el("acercar").disabled = false;
    el("codigo").textContent = site.id;
    el("calle").textContent = site.calle;
    el("tramo").textContent = site.tramo;
    el("referencia").textContent = "Referencia: " + coordinates(site.referencia.latitud, site.referencia.longitud);
    el("criterio").textContent = site.criterio + (site.provisionales.length ? ". Ajustes iniciales provisionales." : ".");
    for (const button of el("estaciones").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.site === site.id));
    }
    drawVariants();
    populateForm();
    focus();
  }

  function drawList() {
    const query = normalizedText(el("buscar").value.trim());
    const type = el("tipo").value;
    const showPins = el("marcadores").checked;
    const buttons = [];
    const matches = (site) => (!type || type === site.tipo) &&
      normalizedText(`${site.id} ${site.calle} ${site.tramo}`).includes(query);
    if (selected && !matches(selected)) {
      pins.get(selected.id).point.pixelSize = 11;
      selected = undefined;
      el("ficha").hidden = true;
      el("acercar").disabled = true;
      const url = new URL(location.href);
      for (const key of ["sitio", "modelo", "ajuste"]) url.searchParams.delete(key);
      history.replaceState(null, "", url);
      overview();
    }
    for (const site of estaciones) {
      const match = matches(site);
      pins.get(site.id).show = showPins && match;
      if (!match) continue;
      const button = document.createElement("button");
      const code = document.createElement("span");
      code.className = "codigo";
      code.textContent = site.id;
      button.type = "button";
      button.dataset.site = site.id;
      button.dataset.tipo = site.tipo;
      button.setAttribute("aria-pressed", String(selected === site));
      button.append(code, site.calle);
      button.addEventListener("click", () => select(site));
      buttons.push(button);
    }
    el("estaciones").replaceChildren(...(buttons.length ? buttons : ["Sin coincidencias."]));
    el("cantidad").textContent = modo === "prueba" ? `Prueba · ${buttons.length}` : `${buttons.length} / ${sites.size}`;
    scene.requestRender();
  }

  function saveLocal() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        ajustes: Object.fromEntries(overrides), variantes: Object.fromEntries(choices),
      }));
    } catch {
      console.warn("El almacenamiento local no está disponible.");
    }
  }

  function saveAdjustment(adjustment) {
    const key = adjustmentKey(selected, variantOf(selected));
    if (adjustment) overrides.set(key, adjustment);
    else overrides.delete(key);
    saveLocal();
    updateLink();
    populateForm();
    focus();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const adjustment = Object.fromEntries(Object.keys(fields).map((key) => [key, form.elements.namedItem(key).valueAsNumber]));
    if (validValues(adjustment)) saveAdjustment(adjustment);
  });
  el("restaurar").addEventListener("click", () => saveAdjustment(null));
  el("buscar").addEventListener("input", drawList);
  el("tipo").addEventListener("change", drawList);
  el("general").addEventListener("click", overview);
  el("acercar").addEventListener("click", focus);
  el("marcadores").addEventListener("change", drawList);
  el("modelos").addEventListener("change", () => {
    if (el("modelos").checked && selected) {
      const variant = variantOf(selected);
      if (modelos.get(variant)?.failed) modelos.delete(variant);
    }
    updateModel();
  });
  el("compartir").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      el("compartir").textContent = "Enlace copiado";
      setTimeout(() => { el("compartir").textContent = "Copiar enlace"; }, 2000);
    } catch {
      status("Copia el enlace desde la barra de direcciones.");
    }
  });
  viewer.screenSpaceEventHandler.setInputAction(({ position }) => {
    const pick = scene.pick(position);
    const site = sites.get(pick?.id?.id);
    if (site) select(site);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  el("leyenda").hidden = false;
  for (const id of ["buscar", "tipo", "general", "marcadores", "modelos", "compartir"]) el(id).disabled = false;
  drawList();
  updateModel();
  const imageryUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
  C.ArcGisMapServerImageryProvider.fromUrl(imageryUrl).then((imagery) => {
    viewer.imageryLayers.addImageryProvider(imagery);
    scene.requestRender();
  }).catch((error) => {
    console.warn("Imágenes satelitales", error);
    const tiles = new C.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" });
    viewer.imageryLayers.addImageryProvider(tiles);
    scene.requestRender();
  });

  try {
    const terrainUrl = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
    terrain = await C.ArcGISTiledElevationTerrainProvider.fromUrl(terrainUrl);
    terrain.errorEvent.addEventListener(() => {
      el("terreno").textContent = "Cobertura de relieve incompleta · revisa la altura";
    });
    viewer.terrainProvider = terrain;
    el("terreno").textContent = "Relieve Esri · propuestas sujetas a revisión";
    const center = C.Rectangle.center(extent);
    C.sampleTerrain(terrain, 12, [center]).then(() => {
      if (!Number.isFinite(center.height)) return;
      overviewGround = center.height;
      if (flightVersion === 0) {
        viewer.camera.setView({ destination: overviewDestination(), orientation: topDown });
      }
      scene.requestRender();
    }).catch((error) => console.warn("Elevación de la vista general", error));
  } catch (error) {
    console.warn("Relieve", error);
    overviewGround = 0;
    el("terreno").textContent = "Relieve no disponible · referencia elipsoidal";
    if (flightVersion === 0) {
      viewer.camera.setView({ destination: overviewDestination(), orientation: topDown });
    }
  }
  if (selected && detail) focus();
  else if (linkedSite && !selected) select(linkedSite);
  scene.requestRender();
}

main().catch((error) => {
  console.error(error);
  el("terreno").textContent = "Visor no disponible";
  el("estado").textContent = error.message;
});
