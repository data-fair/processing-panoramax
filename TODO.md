# TODO — support des fragments (data-fair v6.21 `partOf`)

Objectif : que le jeu de suivi Panoramax soit un fragment du jeu source (masqué des listes,
supprimé avec lui), et que les pickers de la config acceptent les fragments.

Décisions actées :
- seuls les **nouveaux** suivis sont rattachés (pas de PATCH rétroactif des existants) ;
- source elle-même fragment : suivi rattaché au **même parent** que la source, sauf parent virtuel
  (suivi autonome, pour ne pas polluer les sources du virtuel) ;
- droit de création d'un fragment dataset : `readDescription` sur le parent reste suffisant ;
- portée UI : store + tutoriel.

## 1. data-fair — autoriser un fragment dataset sous n'importe quel dataset (BLOQUANT)

- [ ] `api/src/fragments/operations.ts:113` : supprimer la condition `!parent.isVirtual` ;
      retirer `isVirtual` de `ParentLike` (l.103).
- [ ] `tests/features/fragments/fragments-operations.unit.spec.ts:91` : le cas « non virtuel »
      passe dans les acceptés.
- [ ] `tests/features/fragments/dataset-fragments.api.spec.ts:87-88` : retirer le refus, ajouter un
      cas positif (fragment REST sous dataset REST : création OK, ACL dérivée, absent des listings
      par défaut).
- [ ] `docs/architecture/fragments.md` : §1 cas d'usage « jeu technique compagnon », retirer la
      ligne du tableau §3, généraliser §4 (commentaire + tableau des cas), §6, §7, §9.
- [ ] Vérif : `npx playwright test tests/features/fragments/` puis `npm run lint`.

## 2. data-fair UI — onglet Fragments sur tout dataset

- [ ] `ui/src/composables/dataset/dataset-store.ts:157` : retirer `isVirtual` du fetch des
      fragments (tout dataset non-fragment).
- [ ] Textes de l'onglet (fr/en, `fragmentsTutorial1..3`, page dataset) : généraliser
      « ce jeu de données » ; masquer la phrase « sources » quand le parent n'est pas virtuel.
- [ ] Vérif : `npm run test-e2e -- tests/features/ui/fragments.e2e.spec.ts` +
      `npm -w ui run check-types`.

## 3. processing-panoramax — jeu de suivi rattaché (à reprendre après 1+2)

- [ ] `processing-config-schema.json:24,112` : ajouter `&partOf=false,true` aux deux `getItems`
      (sinon fragments invisibles dans les pickers).
- [ ] `lib/state.ts:22` : `createCompanion` accepte `partOf` et le passe au POST si défini.
- [ ] `lib/execute.ts:114` :
      - source sans `partOf` → `{ type: 'dataset', id: sourceDatasetId }` ;
      - source fragment d'application → même `partOf` (frère) ;
      - source fragment de jeu virtuel → autonome (pas de `partOf`).
- [ ] `test-it/sync.test.ts` : asserter le `partOf` du POST suivi + un cas source fragment
      d'application.
- [ ] `README.md:6` : le suivi est un fragment (masqué, supprimé avec le source ; les photos
      Panoramax sont conservées).
- [ ] Vérif : `npm run lint && npm test`.

## Conséquences assumées

- Suppression du jeu source → le suivi part en cascade, les photos restent sur Panoramax.
- Changer le propriétaire d'une source avec un suivi : détacher le suivi d'abord (refus API sinon).
- Un lecteur du parent peut créer un fragment dataset caché sous lui (même règle que pour un
  jeu virtuel aujourd'hui).

skipped : dialogue UI « Rattacher » générique (l'API suffit au process), suppression des photos
Panoramax à la suppression du source, option de config pour rendre le rattachement facultatif.
