require("dotenv").config();
const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_APP_PASSWORD
            }
        });
    }
    return transporter;
}

function parseSubjectAndBody(introPacket, listing) {
    let subject = `Rental Inquiry: ${listing.title} ($${Number(listing.price).toLocaleString()}/mo) - Adityaa Magesh Kumar`;
    let body = introPacket;

    const subjectMatch = introPacket.match(/^Subject:\s*(.+)$/m);
    if (subjectMatch) {
        subject = subjectMatch[1].trim();
        body = introPacket.replace(/^Subject:\s*.+$/m, "").trim();
    }

    return { subject, body };
}

async function extractAgentContact(listing, page) {
    if (!page) return { email: null, agentName: null, brokerage: null };

    try {
        const contactInfo = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            
            // Common broker domains
            const emailMatches = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
            
            // Exclude platform generic support emails
            const filteredEmails = emailMatches.filter(e => {
                const lower = e.toLowerCase();
                return !lower.includes("support@") && 
                       !lower.includes("help@") && 
                       !lower.includes("feedback@") &&
                       !lower.includes("terms@") &&
                       !lower.includes("privacy@") &&
                       !lower.includes("info@streeteasy.com") &&
                       !lower.includes("help@renthop.com");
            });

            // Look for mailto links
            const mailtoLinks = Array.from(document.querySelectorAll("a[href^='mailto:']"))
                .map(a => a.href.replace(/^mailto:/i, "").split("?")[0].trim())
                .filter(Boolean);

            const allFound = [...new Set([...mailtoLinks, ...filteredEmails])];

            // Try to extract agent name
            let agentName = null;
            const agentHeader = document.querySelector(".listing-manager-info h4, .listing-manager-info .bold, [class*='agentName'], [class*='listedBy']");
            if (agentHeader) {
                agentName = agentHeader.innerText.trim();
            }

            // Try to extract brokerage
            let brokerage = null;
            const brokerEl = document.querySelector(".listing-manager-info .company, [class*='brokerage'], [class*='attribution']");
            if (brokerEl) {
                brokerage = brokerEl.innerText.trim();
            }

            return {
                email: allFound[0] || null,
                allEmails: allFound,
                agentName,
                brokerage
            };
        });

        return contactInfo;
    } catch (err) {
        console.warn("⚠️ Error extracting agent contact:", err.message);
        return { email: null, agentName: null, brokerage: null };
    }
}

async function sendBrokerEmail({ to, subject, body }) {
    const transport = getTransporter();
    const senderName = process.env.TENANT_NAME || "Adityaa Magesh Kumar";
    const senderEmail = process.env.GMAIL_USER || "adityaa.magesh@gmail.com";

    const mailOptions = {
        from: `"${senderName}" <${senderEmail}>`,
        to: to,
        replyTo: senderEmail,
        bcc: senderEmail, // Keep a copy in your own inbox for tracking
        subject: subject,
        text: body
    };

    console.log(`📧 Sending direct email to: ${to} (Subject: "${subject}")`);
    const info = await transport.sendMail(mailOptions);
    console.log(`✅ Email sent successfully! MessageId: ${info.messageId}`);
    return info;
}

module.exports = {
    getTransporter,
    parseSubjectAndBody,
    extractAgentContact,
    sendBrokerEmail
};
