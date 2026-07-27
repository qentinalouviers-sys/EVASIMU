/**
 * RDF-SOLAR — configuration locale (clés API)
 * Copiez ce fichier en  config/local.js  et renseignez vos clés.
 * config/local.js est ignoré par Git : vos clés ne partent jamais dans le dépôt.
 *
 * IMPORTANT — sécurisez la clé côté Google Cloud Console avant la mise en ligne :
 *   1. APIs & Services → Library → activer « Solar API » (facturation requise)
 *   2. Credentials → votre clé → « Application restrictions » : HTTP referrers,
 *      avec uniquement votre domaine (ex. https://www.rdf-solar.fr/*)
 *   3. « API restrictions » : restreindre la clé à la seule Solar API
 * Une clé utilisée dans un navigateur est visible des visiteurs : ces
 * restrictions sont ce qui la rend inutilisable ailleurs que sur votre site.
 */
window.RDF_SOLAR_LOCAL = {
  googleSolarApiKey: 'VOTRE_CLE_ICI'
};
