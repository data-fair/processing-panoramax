# processing-panoramax

Traitement Data Fair qui synchronise les photos géolocalisées d'un jeu de données éditable (REST) vers une instance [Panoramax](https://panoramax.fr/).

- Les lignes du jeu source dont le champ pièce jointe porte le concept `http://schema.org/DigitalDocument` sont envoyées comme photos Panoramax, avec leur position (géométrie ou champs latitude/longitude) et éventuellement leur date de prise de vue.
- Un jeu de données de suivi est créé automatiquement : il contient une ligne par photo (identifiant de ligne source, référence de la pièce jointe, identifiant et collection Panoramax, statut, erreur).
- Les photos modifiées sont remplacées, les photos dont la ligne a été supprimée sont supprimées de Panoramax.
- L'exécution est idempotente : les identifiants Panoramax sont dérivés de façon déterministe de la ligne et de la version de la pièce jointe.

## Développement

```sh
npm install
npm run build-types
npm run lint
npm test
```

Les tests s'exécutent sans instance externe : les appels data-fair et Panoramax sont simulés avec `nock`.
