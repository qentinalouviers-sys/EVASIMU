/*!
 * RDF-SOLAR — Vue 3D de l'installation (Three.js)
 * Reconstruit en volume le pan de toit dessiné sur la carte : bâtiment, panneaux
 * inclinés, obstacles (cheminées…), soleil positionné astronomiquement selon
 * l'heure et la saison, avec ombres portées temps réel et caméra orbitale.
 *
 * Dépendances : THREE (three.min.js) + THREE.OrbitControls, chargés par la page hôte.
 * La vue 3D est optionnelle : si THREE est absent, le bouton ne s'affiche pas.
 *
 * Repère 3D : X = est, Y = altitude, Z = sud (azimut boussole a → direction (sin a, 0, −cos a)).
 */
(function (root) {
  'use strict';

  var E = root.RDFSolarEngine;

  /* ---------- Position du soleil (formules astronomiques simplifiées) ---------- */
  // dayOfYear : 1–365, hour : heure solaire locale décimale, lat en degrés.
  // Retourne { elevation, azimuth } en degrés (azimut boussole, 0 = nord).
  function sunPosition(dayOfYear, hour, lat) {
    var rad = Math.PI / 180;
    var decl = 23.44 * Math.sin(rad * (360 / 365) * (dayOfYear - 81));
    var H = 15 * (hour - 12); // angle horaire
    var phi = lat * rad, d = decl * rad, h = H * rad;
    var sinEl = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(h);
    var el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
    var cosAz = (Math.sin(d) - Math.sin(phi) * sinEl) / (Math.cos(phi) * Math.cos(el) || 1e-9);
    var az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
    if (H > 0) az = 360 - az;
    return { elevation: el / rad, azimuth: az };
  }

  var SEASONS = [
    { id: 'ete', label: '21 juin', day: 172 },
    { id: 'equinoxe', label: 'Équinoxe', day: 264 },
    { id: 'hiver', label: '21 déc', day: 355 }
  ];

  /* ---------- Texture satellite au sol (tuiles IGN autour du projet) ---------- */
  // Charge une mosaïque de tuiles orthophoto centrée sur le toit et rappelle
  // onReady(canvas, tailleEnMètres, décalageOrigine) quand assez de tuiles sont là.
  // En cas d'échec (hors ligne, CORS) : silencieux, le sol reste en couleur unie.
  function loadGroundTexture(lat, lng, onReady) {
    var Z = 19, T = 5, TILE = 256; // mosaïque 5×5 tuiles au zoom 19 (~190 m de côté)
    var n = Math.pow(2, Z);
    var latR = lat * Math.PI / 180;
    var xt = (lng + 180) / 360 * n;
    var yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    var x0 = Math.floor(xt) - Math.floor(T / 2), y0 = Math.floor(yt) - Math.floor(T / 2);
    var res = 156543.03392 * Math.cos(latR) / Math.pow(2, Z); // m / pixel
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = T * TILE;
    var ctx = canvas.getContext('2d');
    var pending = T * T, loaded = 0, done = false;
    var finish = function () {
      if (done) return;
      done = true;
      if (loaded === 0) return; // rien reçu : on garde le sol uni
      var half = (T * TILE) / 2;
      onReady(canvas, T * TILE * res, {
        // position monde (X est, Z sud) du centre de la mosaïque par rapport à l'origine locale
        x: (half - (xt - x0) * TILE) * res,
        z: (half - (yt - y0) * TILE) * res
      });
    };
    var timer = setTimeout(finish, 5000);
    for (var ty = 0; ty < T; ty++) {
      for (var tx = 0; tx < T; tx++) {
        (function (tx, ty) {
          var img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = function () {
            ctx.drawImage(img, tx * TILE, ty * TILE);
            loaded++;
            if (--pending === 0) { clearTimeout(timer); finish(); }
          };
          img.onerror = function () { if (--pending === 0) { clearTimeout(timer); finish(); } };
          img.src = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
            '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM' +
            '&TILEMATRIX=' + Z + '&TILEROW=' + (y0 + ty) + '&TILECOL=' + (x0 + tx) + '&FORMAT=image/jpeg';
        })(tx, ty);
      }
    }
  }

  /* ---------- Construction de la scène ---------- */
  function View3D(sim) {
    this.sim = sim;
    this.day = 172;
    this.hour = 14;
    this.playing = false;
    this._build();
  }

  View3D.prototype._build = function () {
    var self = this;
    var sim = this.sim;

    // ---- Overlay DOM par-dessus la carte ----
    this.overlay = document.createElement('div');
    this.overlay.className = 'rdfsim-3d-overlay';
    this.overlay.innerHTML =
      '<div class="rdfsim-3d-topbar">' +
      '  <span class="rdfsim-3d-title">🧊 Vue 3D — faites tourner avec la souris</span>' +
      '  <span class="rdfsim-3d-actions">' +
      '    <button type="button" class="rdfsim-3d-snap">📷 Photo</button>' +
      '    <button type="button" class="rdfsim-3d-close">✕ Retour à la carte</button>' +
      '  </span>' +
      '</div>' +
      '<div class="rdfsim-3d-canvas"></div>' +
      '<div class="rdfsim-3d-bar">' +
      '  <div class="rdfsim-3d-seasons"></div>' +
      '  <input type="range" class="rdfsim-3d-hour" min="5" max="21.5" step="0.25" value="14">' +
      '  <span class="rdfsim-3d-time"></span>' +
      '  <button type="button" class="rdfsim-3d-play">▶ Journée</button>' +
      '</div>';
    sim.mapArea.appendChild(this.overlay);

    this.overlay.querySelector('.rdfsim-3d-close').addEventListener('click', function () { self.close(); });
    this.overlay.querySelector('.rdfsim-3d-snap').addEventListener('click', function () { self.snapshot(); });
    var hourInput = this.overlay.querySelector('.rdfsim-3d-hour');
    this.timeLabel = this.overlay.querySelector('.rdfsim-3d-time');
    hourInput.addEventListener('input', function () {
      self.playing = false;
      self.playBtn.textContent = '▶ Journée';
      self.hour = +hourInput.value;
      self._updateSun();
    });
    this.hourInput = hourInput;

    this.playBtn = this.overlay.querySelector('.rdfsim-3d-play');
    this.playBtn.addEventListener('click', function () {
      self.playing = !self.playing;
      self.playBtn.textContent = self.playing ? '⏸ Pause' : '▶ Journée';
    });

    var seasonsBox = this.overlay.querySelector('.rdfsim-3d-seasons');
    this.seasonBtns = [];
    SEASONS.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.label;
      b.className = i === 0 ? 'is-on' : '';
      b.addEventListener('click', function () {
        self.day = s.day;
        self.seasonBtns.forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        self._updateSun();
      });
      self.seasonBtns.push(b);
      seasonsBox.appendChild(b);
    });

    // ---- Scène ----
    var mount = this.overlay.querySelector('.rdfsim-3d-canvas');
    var w = mount.clientWidth || sim.mapArea.clientWidth;
    var h = mount.clientHeight || (sim.mapArea.clientHeight - 88);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87b5df);
    this.scene.fog = new THREE.Fog(0x87b5df, 120, 420);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 160;

    // Lumières
    this.sunLight = new THREE.DirectionalLight(0xfff3d6, 2.6);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    var sc = this.sunLight.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.far = 400;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.hemi = new THREE.HemisphereLight(0xbdd7f0, 0x6b7a5a, 0.85);
    this.scene.add(this.hemi);

    // Soleil visible + trajectoire du jour
    this.sunBall = new THREE.Mesh(
      new THREE.SphereGeometry(3, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffd76e })
    );
    this.scene.add(this.sunBall);
    this.pathLine = null;

    this._buildWorld();
    this._updateSun();
    this._animate();
    this._onResize = function () {
      var w2 = mount.clientWidth, h2 = mount.clientHeight;
      if (!w2 || !h2) return;
      self.camera.aspect = w2 / h2;
      self.camera.updateProjectionMatrix();
      self.renderer.setSize(w2, h2);
    };
    root.addEventListener('resize', this._onResize);
  };

  /* ---------- Géométrie : sol, bâtiments, pans de toit, panneaux, obstacles ---------- */
  View3D.prototype._buildWorld = function () {
    var sim = this.sim, s = sim.state;
    var origin = s.zones[0].points[0];
    var toXZ = function (p) { return { x: p.x, z: -p.y }; };  // 3D : Z = sud (x = est, y = nord)
    var GUTTER_H = 5.2; // hauteur de gouttière

    // Chaque pan a son propre plan incliné : repère v = direction de la pente (vers l'azimut)
    var zones3d = s.zones.map(function (z) {
      var poly = E.toLocalMeters(z.points, origin).map(toXZ);
      var az = (z.azimuth || 180) * Math.PI / 180;
      var vDir = { x: Math.sin(az), z: -Math.cos(az) };
      var tilt = z.tilt * Math.PI / 180;
      var maxV = Math.max.apply(null, poly.map(function (p) { return p.x * vDir.x + p.z * vDir.z; }));
      return {
        poly: poly,
        heightAt: function (p) {
          var v = p.x * vDir.x + p.z * vDir.z;
          return GUTTER_H + (maxV - v) * Math.tan(tilt);
        }
      };
    });

    // Hauteur du toit en un point : celle du pan qui le contient (sinon gouttière)
    function heightAnywhere(p) {
      for (var i = 0; i < zones3d.length; i++) {
        if (E.pointInPolygon({ x: p.x, y: p.z }, zones3d[i].poly.map(function (q) { return { x: q.x, y: q.z }; }))) {
          return zones3d[i].heightAt(p);
        }
      }
      return GUTTER_H;
    }

    // Centre de l'ensemble des pans
    var cx = 0, cz = 0, nPts = 0;
    zones3d.forEach(function (z3) {
      z3.poly.forEach(function (p) { cx += p.x; cz += p.z; nPts++; });
    });
    cx /= nPts; cz /= nPts;
    this.center = new THREE.Vector3(cx, 0, cz);

    var group = new THREE.Group();

    // Sol : couleur unie immédiatement, remplacée par la photo aérienne IGN dès réception
    var ground = new THREE.Mesh(
      new THREE.CircleGeometry(220, 48),
      new THREE.MeshLambertMaterial({ color: 0x8fa876 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    var self3d = this;
    loadGroundTexture(origin.lat, origin.lng, function (canvas, sizeM, offset) {
      if (self3d._closed) return;
      var tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = self3d.renderer.capabilities.getMaxAnisotropy();
      var photo = new THREE.Mesh(
        new THREE.PlaneGeometry(sizeM, sizeM),
        new THREE.MeshLambertMaterial({ map: tex })
      );
      photo.rotation.x = -Math.PI / 2;
      photo.position.set(offset.x, 0.04, offset.z);
      photo.receiveShadow = true;
      group.add(photo);
    });

    // Pans de toit + murs, pour chaque pan
    var wallMat = new THREE.MeshLambertMaterial({ color: 0xe8e2d4, side: THREE.DoubleSide });
    zones3d.forEach(function (z3) {
      var roof = z3.poly;
      var roofShape = new THREE.Shape(roof.map(function (p) { return new THREE.Vector2(p.x, p.z); }));
      var roofGeo = new THREE.ShapeGeometry(roofShape);
      // ShapeGeometry est construite en XY → remappage en XZ avec la hauteur du plan du pan
      var pos = roofGeo.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        var px = pos.getX(i), pz = pos.getY(i);
        pos.setXYZ(i, px, z3.heightAt({ x: px, z: pz }), pz);
      }
      roofGeo.computeVertexNormals();
      var roofMesh = new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0x9a5f4b, side: THREE.DoubleSide }));
      roofMesh.castShadow = true;
      roofMesh.receiveShadow = true;
      group.add(roofMesh);

      for (var e = 0; e < roof.length; e++) {
        var a = roof[e], b = roof[(e + 1) % roof.length];
        var ha = z3.heightAt(a), hb = z3.heightAt(b);
        var wallGeo = new THREE.BufferGeometry();
        wallGeo.setAttribute('position', new THREE.Float32BufferAttribute([
          a.x, 0, a.z, b.x, 0, b.z, b.x, hb, b.z,
          a.x, 0, a.z, b.x, hb, b.z, a.x, ha, a.z
        ], 3));
        wallGeo.computeVertexNormals();
        var wall = new THREE.Mesh(wallGeo, wallMat);
        wall.castShadow = true;
        wall.receiveShadow = true;
        group.add(wall);
      }
    });

    // Panneaux actifs : quads légèrement au-dessus du plan de leur pan
    var panelMat = new THREE.MeshStandardMaterial({ color: 0x142c4d, roughness: 0.35, metalness: 0.45 });
    var frameMat = new THREE.MeshLambertMaterial({ color: 0xb9c6d6 });
    var lift = 0.12; // surimposition au-dessus du toit
    sim._activePanels().forEach(function (p) {
      var z3 = zones3d[p.zone] || zones3d[0];
      var cs = p.corners.map(function (c) { return toXZ({ x: c.x, y: c.y }); });
      var quad = new THREE.BufferGeometry();
      var v3 = cs.map(function (c) { return [c.x, z3.heightAt(c) + lift, c.z]; });
      quad.setAttribute('position', new THREE.Float32BufferAttribute(
        [].concat(v3[0], v3[1], v3[2], v3[0], v3[2], v3[3]), 3));
      quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
      quad.computeVertexNormals();
      var mesh = new THREE.Mesh(quad, panelMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      // Cadre : fine bordure sous le panneau
      var under = new THREE.BufferGeometry();
      var u3 = cs.map(function (c) { return [c.x, z3.heightAt(c) + lift - 0.05, c.z]; });
      under.setAttribute('position', new THREE.Float32BufferAttribute(
        [].concat(u3[0], u3[1], u3[2], u3[0], u3[2], u3[3]), 3));
      under.computeVertexNormals();
      var underMesh = new THREE.Mesh(under, frameMat);
      underMesh.receiveShadow = true;
      group.add(underMesh);
    });

    // Obstacles : volumes (cheminée…) qui portent ombre sur les panneaux
    var obsMat = new THREE.MeshLambertMaterial({ color: 0xb0543f });
    s.obstacles.forEach(function (o) {
      var om = E.toLocalMeters(o, origin).map(toXZ);
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      om.forEach(function (p) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      });
      var ocx = (minX + maxX) / 2, ocz = (minZ + maxZ) / 2;
      var baseH = heightAnywhere({ x: ocx, z: ocz });
      var hgt = 1.1; // hauteur type cheminée
      var box = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.4, maxX - minX), hgt, Math.max(0.4, maxZ - minZ)),
        obsMat
      );
      box.position.set(ocx, baseH + hgt / 2 - 0.1, ocz);
      box.castShadow = true;
      box.receiveShadow = true;
      group.add(box);
    });

    // Arbres : leur ombre balaie les panneaux selon l'heure et la saison
    var trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2e });
    var leafMat = new THREE.MeshLambertMaterial({ color: 0x2f7a3d });
    (s.trees || []).forEach(function (t) {
      var pm = E.toLocalMeters([{ lat: t.lat, lng: t.lng }], origin)[0];
      var p = toXZ(pm);
      var h = t.h || 8;
      var trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(h * 0.035, h * 0.05, h * 0.45, 8),
        trunkMat
      );
      trunk.position.set(p.x, h * 0.225, p.z);
      trunk.castShadow = true;
      group.add(trunk);
      var foliage = new THREE.Mesh(
        new THREE.SphereGeometry(h * 0.32, 12, 10),
        leafMat
      );
      foliage.position.set(p.x, h * 0.45 + h * 0.28, p.z);
      foliage.castShadow = true;
      foliage.receiveShadow = true;
      group.add(foliage);
    });

    // Rose des vents au sol (repère nord)
    var north = new THREE.Mesh(
      new THREE.ConeGeometry(0.8, 2.6, 4),
      new THREE.MeshBasicMaterial({ color: 0xcf3f2f })
    );
    north.rotation.x = -Math.PI / 2;
    north.position.set(cx, 0.06, cz - 26);
    group.add(north);

    this.scene.add(group);
    this.world = group;

    // Caméra : posée au sud-est du bâtiment, orientée vers les toits
    var span = 0;
    zones3d.forEach(function (z3) {
      z3.poly.forEach(function (p) { span = Math.max(span, Math.hypot(p.x - cx, p.z - cz)); });
    });
    var dist = Math.max(18, span * 3.2);
    this.camera.position.set(cx + dist * 0.7, dist * 0.55, cz + dist * 0.7);
    this.controls.target.set(cx, GUTTER_H * 0.8, cz);
    this.sunLight.target.position.set(cx, 0, cz);
  };

  /* ---------- Soleil : position, éclairage, trajectoire ---------- */
  View3D.prototype._updateSun = function () {
    var s = this.sim.state;
    var lat = s.address ? s.address.lat : 46.6;
    var sp = sunPosition(this.day, this.hour, lat);
    var R = 150;
    var el = Math.max(sp.elevation, -8) * Math.PI / 180;
    var az = sp.azimuth * Math.PI / 180;
    var dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el)
    );
    var pos = dir.clone().multiplyScalar(R).add(this.center);
    this.sunLight.position.copy(pos);
    this.sunBall.position.copy(pos);

    // Nuit / crépuscule : on atténue
    var day = Math.max(0, Math.min(1, (sp.elevation + 4) / 12));
    this.sunLight.intensity = 2.6 * day;
    this.hemi.intensity = 0.25 + 0.6 * day;
    var skyDay = new THREE.Color(0x87b5df), skyNight = new THREE.Color(0x1a2740);
    var sky = skyNight.clone().lerp(skyDay, day);
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color = sky;
    this.sunBall.visible = sp.elevation > -3;

    // Trajectoire du soleil pour la saison choisie
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); }
    var pts = [];
    for (var hh = 5; hh <= 21.5; hh += 0.25) {
      var q = sunPosition(this.day, hh, lat);
      if (q.elevation < 0) continue;
      var e2 = q.elevation * Math.PI / 180, a2 = q.azimuth * Math.PI / 180;
      pts.push(new THREE.Vector3(
        Math.sin(a2) * Math.cos(e2), Math.sin(e2), -Math.cos(a2) * Math.cos(e2)
      ).multiplyScalar(R).add(this.center));
    }
    if (pts.length > 1) {
      this.pathLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0xffd76e, dashSize: 2, gapSize: 1.6, transparent: true, opacity: 0.85 })
      );
      this.pathLine.computeLineDistances();
      this.scene.add(this.pathLine);
    }

    var hInt = Math.floor(this.hour), mInt = Math.round((this.hour - hInt) * 60);
    this.timeLabel.textContent = (hInt < 10 ? '0' : '') + hInt + 'h' + (mInt < 10 ? '0' : '') + mInt +
      (sp.elevation > 0 ? ' · soleil à ' + Math.round(sp.elevation) + '°' : ' · nuit');
  };

  View3D.prototype._animate = function () {
    var self = this;
    this._raf = requestAnimationFrame(function () { self._animate(); });
    if (this.playing) {
      this.hour += 0.02;
      if (this.hour > 21.5) this.hour = 5;
      this.hourInput.value = this.hour;
      this._updateSun();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // Capture PNG de la scène : téléchargée + conservée pour le récapitulatif imprimable
  View3D.prototype.snapshot = function () {
    this.renderer.render(this.scene, this.camera);
    var url = this.renderer.domElement.toDataURL('image/png');
    this.sim._snapshot3d = url;
    var a = document.createElement('a');
    a.href = url;
    a.download = 'rdf-solar-installation-3d.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  View3D.prototype.close = function () {
    this._closed = true;
    cancelAnimationFrame(this._raf);
    root.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    if (this.sim._view3d === this) this.sim._view3d = null;
  };

  /* ---------- API ---------- */
  root.RDFSolar3D = {
    available: function () { return typeof root.THREE !== 'undefined' && !!root.THREE.OrbitControls; },
    open: function (sim) {
      if (!this.available()) return null;
      if (sim._view3d) sim._view3d.close();
      sim._view3d = new View3D(sim);
      return sim._view3d;
    }
  };
})(typeof window !== 'undefined' ? window : this);
