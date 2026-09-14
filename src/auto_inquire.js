const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { extractAgentContact, sendBrokerEmail, parseSubjectAndBody } = require("./mailer");

puppeteer.use(StealthPlugin());

async function submitInquiry(listing, messageText) {
    const tenant = {
        name: process.env.TENANT_NAME || "Adityaa Magesh Kumar",
        email: process.env.TENANT_EMAIL || "adityaa.magesh@gmail.com",
        phone: process.env.TENANT_PHONE || "732-309-5089"
    };

    console.log(`🚀 [Auto-Inquire] Starting automated dispatch for: ${listing.title} (${listing.url})`);

    // 0. If broker email is already known in DB, dispatch immediately without launching browser!
    if (listing.broker_email) {
        console.log(`🎯 Known broker email in DB: ${listing.broker_email}. Sending direct email...`);
        const { subject, body } = parseSubjectAndBody(messageText, listing);
        await sendBrokerEmail({
            to: listing.broker_email,
            subject,
            body
        });
        return {
            success: true,
            method: "email",
            recipient: listing.broker_email
        };
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1920,1080"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        const isRentHop = listing.source === "renthop" || listing.url.includes("renthop.com");

        if (isRentHop) {
            console.log("   Navigating to RentHop listing page...");
            await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 20000 });

            // 1. Check for direct agent email first!
            const agentContact = await extractAgentContact(listing, page);
            if (agentContact && agentContact.email) {
                console.log(`   🎯 Discovered direct agent email: ${agentContact.email}`);
                const { subject, body } = parseSubjectAndBody(messageText, listing);
                await sendBrokerEmail({
                    to: agentContact.email,
                    subject,
                    body
                });
                return {
                    success: true,
                    method: "email",
                    recipient: agentContact.email,
                    agentName: agentContact.agentName
                };
            }

            // Check for contact form
            const formExists = await page.evaluate(() => !!document.querySelector("#id-contact-form"));
            if (!formExists) {
                return {
                    success: false,
                    reason: "RentHop contact form not found on page",
                    fallback: true
                };
            }

            console.log("   Filling RentHop contact form...");
            await page.evaluate((t, msg) => {
                const nameEl = document.querySelector("#renter_name");
                const emailEl = document.querySelector("#renter_email");
                const phoneEl = document.querySelector("#renter_phone");
                const commentEl = document.querySelector("#renter_comments");

                if (nameEl) nameEl.value = t.name;
                if (emailEl) emailEl.value = t.email;
                if (phoneEl) phoneEl.value = t.phone;
                if (commentEl) commentEl.value = msg;
            }, tenant, messageText);

            // Click submit button
            console.log("   Submitting RentHop form...");
            await page.evaluate(() => {
                const submitBtn = document.querySelector(".check-avail, #id-contact-form input[type='submit'], #id-contact-form button");
                if (submitBtn) submitBtn.click();
            });

            await new Promise(r => setTimeout(r, 4000));

            // Check if verification/captcha form triggered
            const verificationState = await page.evaluate(() => {
                const verifyForm = document.querySelector("#contact-phone-verify-form");
                const captchaForm = document.querySelector("#contact-captcha-form");
                const successMsg = document.querySelector(".alert-success, [class*='success']");
                
                const verifyVisible = verifyForm && verifyForm.offsetParent !== null;
                const captchaVisible = captchaForm && captchaForm.offsetParent !== null;
                
                return {
                    needsVerify: verifyVisible,
                    needsCaptcha: captchaVisible,
                    hasSuccess: !!successMsg
                };
            });

            if (verificationState.needsVerify || verificationState.needsCaptcha) {
                console.log("   ⚠️ RentHop requested phone SMS or CAPTCHA verification.");
                return {
                    success: false,
                    reason: "RentHop requires one-time phone SMS/CAPTCHA verification to prevent spam.",
                    fallback: true
                };
            }

            console.log("   ✅ RentHop inquiry submitted successfully!");
            return { success: true };
        } else {
            // StreetEasy
            console.log("   Navigating to StreetEasy listing page...");
            await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 20000 });

            // 1. Check for direct agent email first!
            const agentContact = await extractAgentContact(listing, page);
            if (agentContact && agentContact.email) {
                console.log(`   🎯 Discovered direct agent email on StreetEasy: ${agentContact.email}`);
                const { subject, body } = parseSubjectAndBody(messageText, listing);
                await sendBrokerEmail({
                    to: agentContact.email,
                    subject,
                    body
                });
                return {
                    success: true,
                    method: "email",
                    recipient: agentContact.email,
                    agentName: agentContact.agentName
                };
            }

            // Check if PerimeterX "Press & Hold" is present
            const isBlocked = await page.evaluate(() => {
                const text = document.body.innerText || "";
                return text.includes("Press & Hold") || text.includes("confirm you are a human") || document.querySelector("#px-captcha") !== null;
            });

            if (isBlocked) {
                console.log("   ⚠️ StreetEasy PerimeterX 'Press & Hold' challenge active.");
                return {
                    success: false,
                    reason: "StreetEasy anti-bot security ('Press & Hold' challenge) intercepted the request.",
                    fallback: true
                };
            }

            // Click Ask a question
            const clicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll("button, a"));
                const target = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === "ask a question");
                if (target) {
                    target.click();
                    return true;
                }
                return false;
            });

            if (!clicked) {
                return {
                    success: false,
                    reason: "StreetEasy contact button not found.",
                    fallback: true
                };
            }

            await new Promise(r => setTimeout(r, 3000));

            const modalBlocked = await page.evaluate(() => {
                const text = document.body.innerText || "";
                return text.includes("Press & Hold") || text.includes("confirm you are a human");
            });

            if (modalBlocked) {
                console.log("   ⚠️ StreetEasy PerimeterX challenge popped up upon opening contact form.");
                return {
                    success: false,
                    reason: "StreetEasy anti-bot security ('Press & Hold' challenge) blocked automated inquiry modal.",
                    fallback: true
                };
            }

            return {
                success: false,
                reason: "StreetEasy requires account login to message agents directly.",
                fallback: true
            };
        }
    } catch (err) {
        console.error("   ❌ Auto-inquire error:", err.message);
        return {
            success: false,
            reason: err.message,
            fallback: true
        };
    } finally {
        await browser.close();
    }
}

module.exports = { submitInquiry };
