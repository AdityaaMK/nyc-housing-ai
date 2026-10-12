const https = require("https");

/**
 * Normalizes street names for NYC Open Data Socrata querying.
 * NYC HPD formats: "WEST 56 STREET", "3 AVENUE", "LUDLOW STREET"
 */
function parseAddress(rawAddress) {
    if (!rawAddress) return null;

    // Clean out unit numbers (#20, Apt 4B, 3rd Floor, etc.)
    let clean = rawAddress.replace(/#\s*[a-zA-Z0-9_-]+/g, "")
                          .replace(/Apt\s*[a-zA-Z0-9_-]+/gi, "")
                          .replace(/Unit\s*[a-zA-Z0-9_-]+/gi, "")
                          .replace(/,\s*New York.*$/i, "")
                          .replace(/,\s*NY.*$/i, "")
                          .trim();

    // Extract house number and street
    const match = clean.match(/^(\d+[-/]?\d*)\s+(.+)$/);
    if (!match) return null;

    const houseNumber = match[1].trim();
    let streetName = match[2].toUpperCase().trim();

    // Standardize NYC street naming conventions
    streetName = streetName
        .replace(/\bSTREET\b|\bST\b/g, "STREET")
        .replace(/\bAVENUE\b|\bAVE\b|\bAV\b/g, "AVENUE")
        .replace(/\bBOULEVARD\b|\bBLVD\b/g, "BOULEVARD")
        .replace(/\bPLACE\b|\bPL\b/g, "PLACE")
        .replace(/\bROAD\b|\bRD\b/g, "ROAD")
        .replace(/\bDRIVE\b|\bDR\b/g, "DRIVE")
        .replace(/\bLANE\b|\bLN\b/g, "LANE")
        .replace(/\bWAY\b/g, "WAY")
        .replace(/\bEAST\b|\bE\b/g, "EAST")
        .replace(/\bWEST\b|\bW\b/g, "WEST")
        .replace(/\bNORTH\b|\bN\b/g, "NORTH")
        .replace(/\bSOUTH\b|\bS\b/g, "SOUTH")
        .replace(/\b1ST\b/g, "1")
        .replace(/\b2ND\b/g, "2")
        .replace(/\b3RD\b/g, "3")
        .replace(/(\d+)(TH|RD|ND|ST)\b/g, "$1")
        .replace(/\s+/g, " ")
        .trim();

    return { houseNumber, streetName };
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { "User-Agent": "nyc-housing-ai" }, timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`NYC Open Data returned HTTP ${res.statusCode}`));
            }
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on("error", reject);
        request.on("timeout", () => request.destroy(new Error("NYC Open Data request timed out")));
    });
}

async function fetchHPDViolations(houseNumber, streetName, borough) {
    // SODA endpoint: Housing Maintenance Code Violations
    const street = encodeURIComponent(streetName);
    const num = encodeURIComponent(houseNumber);
    const url = `https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$limit=100&housenumber=${num}&streetname=${street}&boroid=${({ Manhattan: 1, Brooklyn: 3, Queens: 4 })[borough]}&$order=novissueddate%20DESC`;

    const records = await fetchJson(url);
    if (!Array.isArray(records)) return { total: 0, open: 0, classC: 0, bedbugs: 0, heat: 0 };

    let open = 0;
    let classC = 0;
    let bedbugs = 0;
    let heat = 0;

    for (const r of records) {
        const isOpen = (r.currentstatus || "").toUpperCase().includes("OPEN");
        const isC = (r.class || "").toUpperCase() === "C";
        const desc = (r.novdescription || "").toUpperCase();

        if (isOpen) {
            open++;
            if (isC) classC++;
            
            // Only count active bedbug eradication orders, not administrative annual report filings
            if ((desc.includes("BEDBUG") || desc.includes("BED BUG")) && !desc.includes("FILE ANNUAL BEDBUG REPORT")) {
                bedbugs++;
            }

            if (desc.includes("HEAT") || desc.includes("HOT WATER")) {
                heat++;
            }
        }
    }

    return { total: records.length, open, classC, bedbugs, heat };
}

async function fetch311Complaints(houseNumber, streetName, borough) {
    // SODA endpoint: 311 Service Requests
    const incidentAddress = encodeURIComponent(`${houseNumber} ${streetName}`);
    const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=50&incident_address=${incidentAddress}&borough=${borough.toUpperCase()}&$order=created_date%20DESC`;

    const records = await fetchJson(url);
    if (!Array.isArray(records)) return { total: 0, heat: 0, bedbugs: 0, rodents: 0 };

    let heat = 0;
    let bedbugs = 0;
    let rodents = 0;

    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    for (const r of records) {
        const createdDate = new Date(r.created_date || 0);
        if (createdDate < twoYearsAgo) continue;

        const type = (r.complaint_type || "").toUpperCase();
        if (type.includes("HEAT") || type.includes("HOT WATER")) heat++;
        if (type.includes("BEDBUG")) bedbugs++;
        if (type.includes("RODENT")) rodents++;
    }

    return { total: records.length, heat, bedbugs, rodents };
}

async function checkBuildingHealth(rawAddress, borough = 'Manhattan') {
    if (!['Manhattan', 'Brooklyn', 'Queens'].includes(borough)) {
        return { grade: 'Unknown', summary: 'Building health unverified: outside supported NYC boroughs or location unknown', isHazardous: false };
    }
    const parsed = parseAddress(rawAddress);
    if (!parsed) {
        return {
            grade: "Unknown",
            summary: "Building health unverified: address could not be parsed",
            openViolations: 0,
            classC: 0,
            bedbugReports: 0,
            heatComplaints: 0,
            isHazardous: false
        };
    }

    try {
        const [hpd, c311] = await Promise.all([
            fetchHPDViolations(parsed.houseNumber, parsed.streetName, borough),
            fetch311Complaints(parsed.houseNumber, parsed.streetName, borough)
        ]);

        const totalBedbugs = hpd.bedbugs + c311.bedbugs;
        const totalHeat = hpd.heat + c311.heat;
        const openViolations = hpd.open;
        const classC = hpd.classC;

        let grade = "A";
        let isHazardous = false;
        let reasons = [];

        if (totalBedbugs > 0) {
            grade = "C";
            isHazardous = true;
            reasons.push(`${totalBedbugs} bedbug report(s)`);
        }

        if (classC > 0) {
            grade = "C";
            isHazardous = true;
            reasons.push(`${classC} immediately hazardous (Class C) violation(s)`);
        }

        if (totalHeat >= 3) {
            isHazardous = true;
            if (grade !== "C") grade = "C";
            reasons.push(`${totalHeat} winter heat/hot water complaints`);
        } else if (totalHeat > 0 && grade === "A") {
            grade = "B";
            reasons.push(`${totalHeat} heat complaint(s)`);
        }

        if (openViolations > 5 && grade === "A") {
            grade = "B";
            reasons.push(`${openViolations} open building violations`);
        }

        let summary = "";
        if (grade === "A") {
            summary = "Grade A (Clean — 0 open Class C violations, 0 bedbugs)";
        } else if (grade === "B") {
            summary = `Grade B (Moderate — ${reasons.join(", ")})`;
        } else {
            summary = `Grade C (⚠️ High Risk — ${reasons.join(", ")})`;
        }

        return {
            grade,
            summary,
            openViolations,
            classC,
            bedbugReports: totalBedbugs,
            heatComplaints: totalHeat,
            isHazardous
        };
    } catch (err) {
        console.warn("⚠️ Building health check failed:", err.message);
        return {
            grade: "Unknown",
            summary: "Building health unavailable: data lookup failed",
            openViolations: 0,
            classC: 0,
            bedbugReports: 0,
            heatComplaints: 0,
            isHazardous: false
        };
    }
}

module.exports = {
    parseAddress,
    checkBuildingHealth
};
