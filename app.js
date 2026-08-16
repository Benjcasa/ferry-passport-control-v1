let passagers = [];
let stream = null;
let tesseractInitialized = false;
const LONGUEUR_MIN_NOM = 2;
const REGEX_NOM_MAJUSCULE = /^[A-ZÀÂÄÇÈÉÊËÎÏÔÙÛÜŒÆÑ]+(?:[-'’][A-ZÀÂÄÇÈÉÊËÎÏÔÙÛÜŒÆÑ]+)*$/;

function estNomValide(mot, source, type = "nom") {
    const motNormalise = (mot || "").trim().toUpperCase();

    if (motNormalise.length < LONGUEUR_MIN_NOM) {
        console.debug(`[${source}] ${type} rejeté (trop court):`, mot);
        return false;
    }

    if (!REGEX_NOM_MAJUSCULE.test(motNormalise)) {
        console.debug(`[${source}] ${type} rejeté (format invalide):`, mot);
        return false;
    }

    return true;
}

document.addEventListener("DOMContentLoaded", () => {
    document
        .getElementById("pdfFile")
        .addEventListener("change", lirePDF);

    document
        .getElementById("recherche")
        .addEventListener("input", rechercherInstantane);

    chargerDonneesSauvegardees();
});

// ==================== LECTURE PDF ====================
//
//  Le PDF est un tableau. pdf.js fournit la position (x, y) de chaque
//  fragment de texte : on reconstitue les lignes puis les colonnes, au
//  lieu d'aplatir la page en un flux de mots. Un nom composé
//  ("BEN ALI", "DA SILVA", "VAN DEN BERG") occupe une seule cellule et
//  reste donc entier.

const TOLERANCE_LIGNE = 3;      // px : deux fragments à la même hauteur
const ECART_COLONNE = 6;        // px : au-delà, on change de cellule
const REGEX_DATE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/;
const REGEX_DOSSIER = /^\d{6,}$/;

let dernierDiagnostic = null;

async function lirePDF(event) {
    const fichier = event.target.files[0];

    if (!fichier) return;

    const reader = new FileReader();

    reader.onload = async function (e) {
        try {
            const pdf = await pdfjsLib.getDocument(e.target.result).promise;
            passagers = [];

            let colonnes = null;
            let lignesTotal = 0;

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();

                const lignes = reconstituerLignes(textContent.items);
                lignesTotal += lignes.length;

                const colonnesPage = detecterColonnes(lignes);
                if (!colonnes || colonnesPage.source === "en-tête") colonnes = colonnesPage;

                extrairePassagersDesLignes(lignes, colonnesPage);
            }

            // Repli : si la lecture par colonnes ne donne rien, on retente
            // l'ancienne méthode par flux de mots.
            let methode = "colonnes (" + (colonnes ? colonnes.source : "?") + ")";
            if (passagers.length === 0) {
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();
                    extrairePassagersDuTexte(textContent.items.map(it => it.str).join(" "));
                }
                methode = "flux de mots (repli)";
            }

            dernierDiagnostic = {
                pages: pdf.numPages,
                lignes: lignesTotal,
                methode: methode,
                colonnes: colonnes
            };
            console.log("[PDF] " + passagers.length + " passagers — méthode : " + methode, colonnes);

            sauvegarderDonnees();
            afficherStatutChargement(passagers.length, methode);
            mettreAJourStats();

        } catch (erreur) {
            console.error("Erreur lecture PDF :", erreur);
            afficherStatutChargement(null, null, erreur.message);
        }
    };

    reader.readAsArrayBuffer(fichier);
}

function afficherStatutChargement(nombre, methode, erreur) {
    const cible = document.getElementById("resultat");
    cible.textContent = "";

    if (erreur) {
        cible.textContent = "⚠️ Erreur de lecture : " + erreur;
        return;
    }

    if (nombre === 0) {
        cible.textContent = "⚠️ Aucun passager reconnu dans ce PDF.";
        return;
    }

    cible.textContent = "✅ " + nombre + " passagers chargés (lecture par " + methode + ")";
}

// --- Regrouper les fragments de texte en lignes ---------------

function reconstituerLignes(items) {
    const lignes = [];

    items.forEach(item => {
        const texte = (item.str || "").trim();
        if (!texte) return;

        const x = item.transform[4];
        const y = item.transform[5];

        let ligne = lignes.find(l => Math.abs(l.y - y) <= TOLERANCE_LIGNE);

        if (!ligne) {
            ligne = { y: y, fragments: [] };
            lignes.push(ligne);
        }

        ligne.fragments.push({ x: x, largeur: item.width || 0, texte: texte });
    });

    lignes.sort((a, b) => b.y - a.y);                        // du haut vers le bas
    lignes.forEach(l => l.fragments.sort((a, b) => a.x - b.x));

    return lignes.map(l => ({ y: l.y, cellules: fusionnerEnCellules(l.fragments) }));
}

// --- Fusionner les fragments proches en cellules --------------

function fusionnerEnCellules(fragments) {
    const cellules = [];
    let courante = null;

    fragments.forEach(f => {
        if (courante && f.x - (courante.x + courante.largeur) <= ECART_COLONNE) {
            courante.texte += " " + f.texte;
            courante.largeur = (f.x + f.largeur) - courante.x;
        } else {
            courante = { x: f.x, largeur: f.largeur, texte: f.texte };
            cellules.push(courante);
        }
    });

    return cellules.map(c => ({ x: c.x, texte: c.texte.replace(/\s+/g, " ").trim() }));
}

// --- Repérer l'en-tête et l'index des colonnes ----------------

function detecterColonnes(lignes) {
    for (const ligne of lignes) {
        const textes = ligne.cellules.map(c => c.texte.toLowerCase());

        const iNom = textes.findIndex(t => /^n(om)?\.?$/.test(t) || /\bnom\b/.test(t));
        const iPrenom = textes.findIndex(t => /^pr[ée]nom/.test(t) || /\bpr[ée]nom\b/.test(t));

        if (iNom !== -1 && iPrenom !== -1 && iNom !== iPrenom) {
            return {
                source: "en-tête",
                nom: iNom,
                prenom: iPrenom,
                naissance: textes.findIndex(t => /naissance|date de n|birth|d\.?d\.?n/.test(t)),
                dossier: textes.findIndex(t => /dossier|r[ée]serv|booking|billet/.test(t)),
                yEntete: ligne.y
            };
        }
    }

    // Repli : 3e colonne = Nom, 4e colonne = Prénom
    return { source: "position par défaut", nom: 2, prenom: 3, naissance: -1, dossier: -1, yEntete: null };
}

// --- Extraire les passagers des lignes ------------------------

function cellule(ligne, index) {
    if (index < 0 || index >= ligne.cellules.length) return "";
    return ligne.cellules[index].texte;
}

function extrairePassagersDesLignes(lignes, colonnes) {
    const colonnesMin = Math.max(colonnes.nom, colonnes.prenom) + 1;

    lignes.forEach(ligne => {
        if (colonnes.yEntete !== null && ligne.y >= colonnes.yEntete) return;
        if (ligne.cellules.length < colonnesMin) return;

        const nom = cellule(ligne, colonnes.nom);
        const prenom = cellule(ligne, colonnes.prenom);

        if (!contientDesLettres(nom)) return;

        const toutes = ligne.cellules.map(c => c.texte);

        let naissance = colonnes.naissance !== -1 ? cellule(ligne, colonnes.naissance) : "";
        if (REGEX_DATE.test(naissance)) {
            naissance = naissance.match(REGEX_DATE)[0];
        } else {
            const trouvee = toutes.find(t => REGEX_DATE.test(t));
            naissance = trouvee ? trouvee.match(REGEX_DATE)[0] : "";
        }

        let dossier = colonnes.dossier !== -1 ? cellule(ligne, colonnes.dossier) : "";
        if (!REGEX_DOSSIER.test(dossier)) {
            dossier = toutes.find(t => REGEX_DOSSIER.test(t)) || "";
        }

        const nomPropre = nettoyerCellule(nom);
        const prenomPropre = nettoyerCellule(prenom);

        const doublon = passagers.some(p =>
            p.nom === nomPropre && p.prenom === prenomPropre && p.naissance === naissance);
        if (doublon) return;

        passagers.push({
            id: passagers.length,
            dossier: dossier,
            nom: nomPropre,
            prenom: prenomPropre,
            naissance: naissance,
            controle: false,
            heureControle: "",
            cartouches: 0,
            bouteilles: 0
        });
    });
}

function contientDesLettres(texte) {
    return /[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]{2,}/.test(texte || "");
}

function nettoyerCellule(texte) {
    return (texte || "").replace(/[,;]+$/, "").replace(/\s+/g, " ").trim().toUpperCase();
}

// --- Ancienne extraction, conservée comme repli ---------------

function extrairePassagersDuTexte(texte) {
    const mots = texte.replace(/\r\n/g, "\n").split(/\s+/);

    let i = 0;
    while (i < mots.length) {
        if (estNomValide(mots[i], "PDF", "nom") && i + 1 < mots.length &&
            estNomValide(mots[i + 1], "PDF", "prénom")) {

            let date = "";
            let indexDate = -1;

            for (let j = i + 2; j < Math.min(i + 7, mots.length); j++) {
                if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(mots[j])) {
                    date = mots[j];
                    indexDate = j;
                    break;
                }
            }

            if (date) {
                const nom = mots[i].toUpperCase();
                const prenom = mots[i + 1].toUpperCase();

                let dossier = "";
                for (let j = Math.max(0, i - 5); j < i; j++) {
                    if (/^\d{9,}$/.test(mots[j])) { dossier = mots[j]; break; }
                }

                const doublon = passagers.some(p =>
                    p.nom === nom && p.prenom === prenom && p.naissance === date);

                if (!doublon) {
                    passagers.push({
                        id: passagers.length, dossier: dossier, nom: nom, prenom: prenom,
                        naissance: date, controle: false, heureControle: "",
                        cartouches: 0, bouteilles: 0
                    });
                }

                i = indexDate + 1;      // corrigé : on repart après la date réellement trouvée
                continue;
            }
        }
        i++;
    }
}

// ==================== RECHERCHE ====================
//
//  Insensible aux accents, aux traits d'union et aux apostrophes.
//  Tous les mots saisis doivent être présents, dans n'importe quel
//  ordre : « fatma ben ali » trouve BEN ALI Fatma.

const MAX_RESULTATS_AFFICHES = 100;

// Deux formes de comparaison, mises en cache sur le passager :
//   espacée : "BEN ALI FATMA 12/03/1985"
//   collée  : "BENALIFATMA12/03/1985"  (retrouve O'BRIEN en tapant OBRIEN)
function texteRecherche(p) {
    if (!p._recherche) {
        const espacee = normaliserTexte(
            [p.nom, p.prenom, p.naissance, p.dossier].filter(Boolean).join(" ")
        );
        p._recherche = { espacee: espacee, collee: espacee.replace(/ /g, "") };
    }
    return p._recherche;
}

function filtrerPassagers(saisie) {
    const termes = normaliserTexte(saisie).split(" ").filter(Boolean);
    if (termes.length === 0) return [];

    return passagers.filter(p => {
        const cible = texteRecherche(p);
        return termes.every(t =>
            cible.espacee.includes(t) || cible.collee.includes(t.replace(/ /g, ""))
        );
    });
}

function echapperHtml(valeur) {
    return String(valeur == null ? "" : valeur)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function rechercherInstantane() {
    const saisie = document.getElementById("recherche").value.trim();
    const resultat = document.getElementById("resultatRecherche");

    if (saisie.length < 2) {
        resultat.innerHTML = "";
        return;
    }

    const trouves = filtrerPassagers(saisie);

    if (trouves.length === 0) {
        resultat.innerHTML = '<p class="aucun-resultat">Aucun passager ne correspond à « ' +
            echapperHtml(saisie) + ' ».</p>';
        return;
    }

    const affiches = trouves.slice(0, MAX_RESULTATS_AFFICHES);

    let html = '<p class="compteur-resultats">' + trouves.length + ' passager' +
        (trouves.length > 1 ? 's' : '') + ' trouvé' + (trouves.length > 1 ? 's' : '');

    if (trouves.length > affiches.length) {
        html += ' — ' + affiches.length + ' affichés, affinez la recherche';
    }
    html += '</p>';

    affiches.forEach(p => {
        const nom = echapperHtml(p.nom);
        const prenom = echapperHtml(p.prenom);
        const naissance = echapperHtml(p.naissance || "-");
        const dossier = echapperHtml(p.dossier || "-");
        const id = Number(p.id);

        html += `
            <div class="passager ${p.controle ? 'deja-controle' : 'non-controle'}">

                <strong>${nom} ${prenom}</strong><br>

                <span class="passenger-detail">
                    Date de naissance : ${naissance}
                </span><br>

                <span class="passenger-detail">
                    Dossier : ${dossier}
                </span>
        `;

        if (p.controle) {
            html += `
                <div class="control-status">
                    ✓ Contrôlé : ${echapperHtml(p.heureControle)}
                </div>

                <div class="quantity-section">
                    <div class="quantity-group">
                        <label>Cartouches :</label>
                        <span class="quantity-value">${Number(p.cartouches) || 0}</span>
                        <div class="button-group">
                            <button onclick="modifierCartouches(${id},1)" class="btn-plus">+</button>
                            <button onclick="modifierCartouches(${id},-1)" class="btn-minus">−</button>
                        </div>
                    </div>

                    <div class="quantity-group">
                        <label>Bouteilles :</label>
                        <span class="quantity-value">${Number(p.bouteilles) || 0}</span>
                        <div class="button-group">
                            <button onclick="modifierBouteilles(${id},1)" class="btn-plus">+</button>
                            <button onclick="modifierBouteilles(${id},-1)" class="btn-minus">−</button>
                        </div>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="control-action">
                    <button onclick="validerControle(${id})" class="btn-control">
                        ✓ Contrôler
                    </button>
                </div>
            `;
        }

        html += `</div>`;
    });

    resultat.innerHTML = html;
}

// ==================== CONTRÔLE ====================

function validerControle(id) {
    const passager = passagers.find(p => p.id === id);

    if (!passager) return;

    passager.controle = true;
    passager.cartouches = 0;
    passager.bouteilles = 0;
    passager.heureControle = new Date().toLocaleString("fr-FR");

    sauvegarderDonnees();
    mettreAJourStats();
    rechercherInstantane();
}

function modifierCartouches(id, variation) {
    const passager = passagers.find(p => p.id === id);

    if (!passager) return;

    passager.cartouches += variation;
    if (passager.cartouches < 0) passager.cartouches = 0;
    if (passager.cartouches > 2) passager.cartouches = 2;

    sauvegarderDonnees();
    mettreAJourStats();
    rechercherInstantane();
}

function modifierBouteilles(id, variation) {
    const passager = passagers.find(p => p.id === id);

    if (!passager) return;

    passager.bouteilles += variation;
    if (passager.bouteilles < 0) passager.bouteilles = 0;
    if (passager.bouteilles > 2) passager.bouteilles = 2;

    sauvegarderDonnees();
    mettreAJourStats();
    rechercherInstantane();
}

// ==================== STATISTIQUES ====================

function mettreAJourStats() {
    const total = passagers.length;
    const controles = passagers.filter(p => p.controle).length;
    const restants = total - controles;
    const cartouches = passagers.reduce((somme, p) => somme + (p.cartouches || 0), 0);
    const bouteilles = passagers.reduce((somme, p) => somme + (p.bouteilles || 0), 0);

    // Les classes stat-total / stat-checked / … portent les couleurs
    // définies dans style.css : elles doivent être conservées ici, sinon
    // les tuiles perdent leur mise en forme dès le premier chargement.
    document.getElementById("stats").innerHTML = `
        <div class="stats-grid">
            <div class="stat-item stat-total">
                <div class="stat-label">👥 Total</div>
                <div class="stat-value">${total}</div>
            </div>
            <div class="stat-item stat-checked">
                <div class="stat-label">✅ Contrôlés</div>
                <div class="stat-value">${controles}</div>
            </div>
            <div class="stat-item stat-remaining">
                <div class="stat-label">⏳ Restants</div>
                <div class="stat-value">${restants}</div>
            </div>
            <div class="stat-item stat-cigarettes">
                <div class="stat-label">🚬 Cartouches</div>
                <div class="stat-value">${cartouches}</div>
            </div>
            <div class="stat-item stat-bottles">
                <div class="stat-label">🍾 Bouteilles</div>
                <div class="stat-value">${bouteilles}</div>
            </div>
        </div>
    `;
}

// ==================== SCANNER PASSEPORT ====================

function ouvrirScanner() {
    if (passagers.length === 0) {
        alert("Veuillez d'abord charger un fichier PDF");
        return;
    }

    document.getElementById("scannerModal").style.display = "flex";
    document.getElementById("cameraContainer").style.display = "block";
    document.getElementById("photoContainer").style.display = "none";
    document.getElementById("resultatScanner").style.display = "none";

    // Accéder à la caméra
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
    })
    .then(s => {
        stream = s;
        document.getElementById("videoElement").srcObject = stream;
    })
    .catch(err => {
        alert("Erreur accès caméra : " + err.message);
    });
}

function fermerScanner() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    document.getElementById("scannerModal").style.display = "none";
}

function capturerPhoto() {
    const video = document.getElementById("videoElement");
    const canvas = document.getElementById("photoCanvas");
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0);

    document.getElementById("cameraContainer").style.display = "none";
    document.getElementById("photoContainer").style.display = "block";
}

function reprendreScan() {
    document.getElementById("cameraContainer").style.display = "block";
    document.getElementById("photoContainer").style.display = "none";
    document.getElementById("resultatScanner").style.display = "none";
}

async function analyserPhoto() {
    const canvas = document.getElementById("photoCanvas");
    const chargement = document.getElementById("chargement");
    const resultatScanner = document.getElementById("resultatScanner");

    chargement.style.display = "block";
    resultatScanner.style.display = "none";

    try {
        // Initialiser Tesseract si pas fait
        if (!tesseractInitialized) {
            await Tesseract.recognize(canvas, "fra");
            tesseractInitialized = true;
        }

        // Extraire le texte de la photo
        const { data: { text } } = await Tesseract.recognize(canvas, "fra");
        
        console.log("OCR résultat:", text);
        
        // Chercher le nom dans le texte OCR
        const nomsDetectes = trouverNomsOCR(text);
        
        // Chercher dans la liste des passagers
        const resultats = trouverPassagersOCR(nomsDetectes);

        chargement.style.display = "none";
        resultatScanner.style.display = "block";

        afficherResultatsScanner(resultats);

    } catch (err) {
        chargement.style.display = "none";
        alert("Erreur OCR : " + err.message);
    }
}

// Normalise un texte pour la comparaison (accents, tirets, espaces)
function normaliserTexte(texte) {
    return texte
        .toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // supprimer accents
        .replace(/[-'\s]+/g, " ")                          // tirets/apostrophes -> espace
        .trim();
}

// Calcule la distance de Levenshtein entre deux chaînes
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Retourne vrai si deux tokens sont suffisamment similaires
function tokensSimilaires(a, b) {
    if (a === b) return true;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    // Tolérance : 0 erreur pour ≤3 chars, 1 pour ≤6, 2 pour >6
    const tolerance = maxLen <= 3 ? 0 : maxLen <= 6 ? 1 : 2;
    return dist <= tolerance;
}

// Extrait les noms potentiels du texte OCR
function trouverNomsOCR(texte) {
    console.log("[OCR] Texte brut reçu :\n" + texte);

    // Chercher une date de naissance (DD/MM/YYYY) comme point d'ancrage
    const regexDate = /\b(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})\b/;
    const matchDate = texte.match(regexDate);
    let zone = texte;
    if (matchDate) {
        // Extraire seulement la partie précédant la date
        zone = texte.substring(0, matchDate.index);
        console.log("[OCR] Date trouvée : " + matchDate[0] + " — analyse de la zone précédente");
    } else {
        console.log("[OCR] Aucune date trouvée, analyse du texte complet");
    }

    const noms = [];
    const regexNom = /^[A-ZÀÂÄÇÈÉÊËÎÏÔÙÛÜŒÆÑ][A-ZÀÂÄÇÈÉÊËÎÏÔÙÛÜŒÆÑ'\-]*$/;
    const mots = zone.split(/[\s\n,;:.()\[\]\/\\|]+/);

    mots.forEach(mot => {
        mot = mot.trim().toUpperCase();
        if (estNomValide(mot, "OCR")) {
            noms.push(mot);
        }
    });

    console.log("[OCR] Noms/tokens détectés : " + JSON.stringify(noms));
    return noms;
}

// Cherche les passagers correspondant aux noms trouvés
function trouverPassagersOCR(nomsDetectes) {
    const resultats = [];

    nomsDetectes.forEach(nomOCR => {
        const tokenOCR = normaliserTexte(nomOCR);

        passagers.forEach(p => {
            if (resultats.find(r => r.id === p.id)) return;

            // Normaliser nom et prénom du passager en tokens individuels
            const tokensNom    = normaliserTexte(p.nom    || "").split(" ").filter(Boolean);
            const tokensPrenom = normaliserTexte(p.prenom || "").split(" ").filter(Boolean);
            const tousTokens   = [...tokensNom, ...tokensPrenom];

            const trouve = tousTokens.some(t => tokensSimilaires(tokenOCR, t));

            if (trouve) {
                console.log(`[OCR] Correspondance trouvée : "${nomOCR}" ~ "${p.nom} ${p.prenom}"`);
                resultats.push(p);
            } else {
                console.debug(`[OCR] Pas de correspondance : "${nomOCR}" vs tokens ${JSON.stringify(tousTokens)}`);
            }
        });
    });

    console.log("[OCR] Total passagers trouvés : " + resultats.length);
    return resultats.slice(0, 10); // Limiter à 10 résultats
}

// Affiche les résultats du scanner
function afficherResultatsScanner(resultats) {
    const listeResultats = document.getElementById("listeResultats");

    if (resultats.length === 0) {
        listeResultats.innerHTML = "<p>Aucun passager trouvé. Vérifiez la photo.</p>";
        return;
    }

    if (resultats.length === 1) {
        // Un seul résultat : valider directement
        const p = resultats[0];
        listeResultats.innerHTML = `
            <div class="passager non-controle">
                <strong>${p.nom} ${p.prenom}</strong><br>
                <span class="passenger-detail">Date : ${p.naissance}</span><br>
                <button onclick="validerControle(${p.id}); fermerScanner();" class="btn-control">
                    ✓ Valider ce passager
                </button>
            </div>
        `;
        return;
    }

    // Plusieurs résultats : afficher liste
    let html = "";
    resultats.forEach(p => {
        html += `
            <div class="passager non-controle">
                <strong>${p.nom} ${p.prenom}</strong><br>
                <span class="passenger-detail">Date : ${p.naissance}</span><br>
                <button onclick="validerControle(${p.id}); fermerScanner();" class="btn-control">
                    ✓ C'est lui
                </button>
            </div>
        `;
    });
    listeResultats.innerHTML = html;
}

// ==================== SAUVEGARDE ====================

function sauvegarderDonnees() {
    // le cache de recherche (_recherche) n'est pas persiste : il est
    // reconstruit a la volee, et alourdirait inutilement le stockage
    const aStocker = passagers.map(({ _recherche, ...reste }) => reste);
    localStorage.setItem("passagers", JSON.stringify(aStocker));
}

function chargerDonneesSauvegardees() {
    const donnees = localStorage.getItem("passagers");

    if (!donnees) return;

    passagers = JSON.parse(donnees);
    mettreAJourStats();
}
