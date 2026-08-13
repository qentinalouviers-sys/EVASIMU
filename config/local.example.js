/**
 * RDF-SOLAR — configuration locale (clés API et endpoints)
 * Copiez ce fichier en  config/local.js  et renseignez vos valeurs.
 * config/local.js est ignoré par Git : rien ne part dans le dépôt.
 *
 * IMPORTANT — sécurisez la clé Google côté Cloud Console avant la mise en ligne :
 *   1. APIs & Services → Library → activer « Solar API » (facturation requise)
 *   2. Credentials → votre clé → « Application restrictions » : HTTP referrers,
 *      avec uniquement votre domaine (ex. https://www.eviatek.fr/*)
 *   3. « API restrictions » : restreindre la clé à la seule Solar API
 * Une clé utilisée dans un navigateur est visible des visiteurs : ces
 * restrictions sont ce qui la rend inutilisable ailleurs que sur votre site.
 */
window.RDF_SOLAR_LOCAL = {
  // Détection automatique des pans de toit (option payante, facultative)
  googleSolarApiKey: '',

  // Proxy PVGIS — production calculée sur données satellitaires réelles, relief
  // et température inclus. Aucune clé, aucun coût : il suffit de lancer
  //   node server/pvgis-proxy.js
  // et de servir ce endpoint derrière votre domaine (voir README § proxy PVGIS).
  //   développement : 'http://localhost:8787/api/pvgis'
  //   production    : '/api/pvgis'   (reverse proxy vers le service)
  // Laissez vide pour utiliser uniquement le moteur embarqué.
  pvgisProxyUrl: ''
};
