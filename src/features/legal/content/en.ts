/**
 * Legal pages in English: same structure as fr.ts, section by section
 * (checked by legal.test.ts). The French text prevails in case of conflict.
 */
import type { LegalPublisher } from '../lib/publisher';
import type { LegalChrome, LegalDocuments } from '../lib/types';

const MISSING = '[to be completed]';

export const ENGLISH_CHROME: LegalChrome = {
  updatedOn: 'Last updated: {{date}}',
  backToApp: 'Back to RedView',
  navLabel: 'Legal information',
  missing: MISSING,
  pageLabels: {
    'legal-notice': 'Legal notice',
    privacy: 'Privacy',
    terms: 'Terms of use',
    accessibility: 'Accessibility',
  },
};

export function englishLegalDocuments(publisher: LegalPublisher): LegalDocuments {
  const v = (value: string | null) => value ?? MISSING;
  const editor = v(publisher.name);
  const contact = publisher.contactEmail ? `[${publisher.contactEmail}](mailto:${publisher.contactEmail})` : MISSING;
  const host = publisher.host;
  const region = v(host.region);
  const prevails = 'This English version is provided for convenience; the French version prevails.';

  return {
    'legal-notice': {
      title: 'Legal notice',
      lead: `Information about the publisher and the host of the RedView service (app.redview.tech), under article 1-1 of French law no. 2004-575 of 21 June 2004 on confidence in the digital economy. ${prevails}`,
      sections: [
        {
          heading: 'Publisher',
          blocks: [
            { p: `RedView is published by ${editor}, ${v(publisher.legalForm)}, registered under number ${v(publisher.registration)}, with its registered office at ${v(publisher.address)}.` },
            { ul: [`Phone: ${v(publisher.phone)}`, `Email: ${contact}`, `EU VAT number: ${v(publisher.vatNumber)}`] },
          ],
        },
        {
          heading: 'Publication director',
          blocks: [{ p: v(publisher.publicationDirector) }],
        },
        {
          heading: 'Hosting',
          blocks: [
            { p: `The service is hosted on Oracle Cloud infrastructure by ${v(host.name)}, ${v(host.address)}, phone ${v(host.phone)}, on servers located in: ${region}.` },
            { p: 'Accounts, projects, files, audience measurement and error tracking are hosted on these same servers, without any third-party hosting provider.' },
          ],
        },
        {
          heading: 'Contact and reporting',
          blocks: [
            { p: `For any question, to exercise your rights over your data or to report illegal content: ${contact}. We answer in French and English.` },
          ],
        },
        {
          heading: 'Intellectual property',
          blocks: [
            { p: `The RedView service, its code, computation engines, texts, brand and graphic assets are the exclusive property of ${editor}. Any reproduction or reuse without written permission is prohibited.` },
            { p: 'Map, elevation, weather and point-of-interest data come from third-party sources under their own licences: the list and the attributions are in Settings → Data sources.' },
          ],
        },
      ],
    },

    privacy: {
      title: 'Privacy policy',
      lead: `This policy explains what data RedView processes, why, for how long, with whom, and how to exercise your rights (Regulation (EU) 2016/679, “GDPR”, and the French Data Protection Act). ${prevails}`,
      sections: [
        {
          heading: '1. Data controller',
          blocks: [
            { p: `The data controller is ${editor}, ${v(publisher.address)}. For any question or request about your data: ${contact}.` },
          ],
        },
        {
          heading: '2. Data processed, purposes and legal bases',
          blocks: [
            {
              ul: [
                'Account and sign-in: name, email address, password (stored hashed, never in clear), Google identifier if you sign in with Google, sessions. Purpose: providing the service. Basis: performance of the contract.',
                'Service emails: email address, single-use verification codes (valid for 10 minutes), notices about your account and subscription. Basis: performance of the contract.',
                'Projects: routes, start and waypoint locations (location data), settings, comments, thumbnails, imported files. Basis: performance of the contract.',
                'FIT activity files: timestamped GPS tracks, speed, power, cadence and heart rate, which may reveal information about your health. Purpose: calibrating the prediction of your riding time. Basis: your explicit consent, asked before any import and withdrawable at any time in Account → Your data (withdrawing erases the FIT files of your account).',
                'Co-editing a shared project: account identifier, name, edits; the cursor position and map view of other editors are sent live but never recorded. Basis: performance of the contract.',
                'Subscription and payment: customer and subscription identifiers at our payment provider, invoices. Your card details are entered into and kept by the provider, never by RedView. Bases: performance of the contract and accounting obligations.',
                'Audience measurement: anonymous events (screens viewed, actions in categories and rounded values), without cookies, account identifier or email address, with a tool hosted by RedView. Basis: legitimate interest, under the consent exemption conditions of the CNIL; you can object in Settings → Audience measurement.',
                'Error tracking: error message, page without parameters, browser and application version, with a tool hosted by RedView. Basis: legitimate interest (reliability of the service).',
                'Technical logs: method, route, status and duration of requests, with no IP address or full URL in the application logs; the front web server logs may contain the IP address. Basis: legitimate interest (security) and legal retention obligations.',
                'Backups: encrypted copy of all data, to be able to restore the service. Basis: legitimate interest (continuity of service).',
              ],
            },
          ],
        },
        {
          heading: '3. The map and data sources',
          blocks: [
            { p: 'To display the map, terrain, imagery, weather and LiDAR point clouds, your browser contacts tile and data providers directly: Mapbox, IGN, swisstopo, Amazon Web Services (worldwide terrain) and, depending on the area viewed, other national mapping agencies. They receive your IP address and the area displayed, as for any website that uses them. The precipitation radar (EUMETNET OPERA composites) is read and drawn by our servers: your browser does not contact its provider.' },
            { p: 'Mapbox also stores a random identifier in your browser storage, sent with its map-load statistics. These statistics are used by Mapbox (billing and operation of its service) and contain neither your name nor your email address.' },
          ],
        },
        {
          heading: '4. Recipients and processors',
          blocks: [
            { p: 'Your data is never sold or rented. It is accessible only to the people who need it to run the service, and to our processors:' },
            {
              ul: [
                `Oracle (hosting of all RedView servers) — servers located in: ${region}.`,
                'Resend (sending service emails) — United States.',
                'Stripe (subscription payments) — European Union and United States.',
                'Google (Sign in with Google, if you choose it; storage of our backups, encrypted before upload: Google has no access to their content) — United States.',
                'Mapbox (map display, see § 3) — United States.',
              ],
            },
            { p: 'People you invite to a shared project see that project, its comments and your name.' },
          ],
        },
        {
          heading: '5. Transfers outside the European Union',
          blocks: [
            { p: 'Some providers are established in the United States. These transfers rely on the European Commission adequacy decision of 10 July 2023 (EU-U.S. Data Privacy Framework) for certified companies, or otherwise on the European Commission standard contractual clauses.' },
          ],
        },
        {
          heading: '6. Retention periods',
          blocks: [
            {
              ul: [
                'Account, projects and files: until you delete your account or the project.',
                'After a deletion: data disappears from the service immediately, then from backups at the latest 12 months later (backup rotation).',
                'Verification codes: 10 minutes.',
                'Audience measurement: 25 months.',
                'Technical logs: 30 days; route computation log: 48 hours.',
                'Invoices and accounting records: 10 years (article L.123-22 of the French Commercial Code), at our payment provider.',
                'Account deletion register: identifier and dates only, so that restoring a backup never brings back a deleted account.',
              ],
            },
          ],
        },
        {
          heading: '7. Your rights',
          blocks: [
            { p: 'You have the right to access, rectify, erase, restrict, object to and port your data, and the right to withdraw your consent at any time. Most of them can be exercised directly in the application:' },
            {
              ul: [
                'Access and portability: Account → Your data → download all your data (ZIP archive).',
                'Erasure: Account → Your data → delete my account (confirmed by a code sent by email).',
                'Rectification: Account → Details.',
                'Withdrawing consent to FIT files: Account → Your data.',
                'Objecting to audience measurement: Settings → Audience measurement.',
              ],
            },
            { p: `For any other request: ${contact}. We answer within one month. You may also lodge a complaint with the CNIL ([www.cnil.fr](https://www.cnil.fr), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, France).` },
          ],
        },
        {
          heading: '8. Security',
          blocks: [
            { p: 'Exchanges are encrypted (HTTPS), passwords are stored hashed, backups are encrypted before leaving our servers, access to projects is checked on every request, and repeated attempts are rate-limited. If a data breach poses a risk to you, we notify the CNIL within 72 hours and inform you if the risk is high.' },
          ],
        },
        {
          heading: '9. Cookies and browser storage',
          blocks: [
            { p: 'RedView sets no advertising or measurement cookies. The account service may set a session cookie, strictly necessary for signing in. Your browser storage keeps your session, display preferences, a local copy of your projects (offline work), map tiles already loaded and the LiDAR point clouds you download: these are necessary for the service you request and are not used to track you. The Mapbox identifier is described in § 3.' },
          ],
        },
        {
          heading: '10. Minors',
          blocks: [
            { p: 'RedView is intended for people aged 15 and over. Subscribing to a paid plan is reserved for adults.' },
          ],
        },
        {
          heading: '11. Changes',
          blocks: [
            { p: 'This policy may change with the service. The last update date is shown at the top of the page; in case of a significant change, we inform you in the application or by email.' },
          ],
        },
      ],
    },

    terms: {
      title: 'Terms of use and sale',
      lead: `These terms govern the use of the RedView service, published by ${editor}. Creating an account means accepting these terms and the [privacy policy](/confidentialite). ${prevails}`,
      sections: [
        {
          heading: '1. The service',
          blocks: [
            { p: 'RedView is a web application for planning and analysing routes in 3D terrain (ultra-cycling, bikepacking, trail): route computation, riding-time prediction, terrain, weather and snow analysis, LiDAR point-cloud viewing, project co-editing.' },
            { p: 'The service is currently in beta: features may change, be added or be removed.' },
          ],
        },
        {
          heading: '2. Access and account',
          blocks: [
            { p: 'The service is reserved for people aged 15 and over. You agree to provide a valid email address, to keep your password secret and to tell us about any unauthorised use of your account. You are responsible for the activity of your account.' },
          ],
        },
        {
          heading: '3. Information provided by the service: for guidance only',
          blocks: [
            { p: 'Routes, riding times, profiles, weather forecasts, snow depths, avalanche terrain exposure and other analyses are estimates computed from third-party data and models. They may be inaccurate, incomplete or out of date and replace neither official sources (Météo-France bulletins, avalanche risk bulletins, traffic orders) nor your own judgement in the field. You alone remain responsible for your outings, your safety and compliance with traffic rules and access rules for natural areas.' },
          ],
        },
        {
          heading: '4. Your content',
          blocks: [
            { p: 'You remain the owner of the projects, comments and files you create or import. You grant us only the right to host, process and display them, to you and to the people you share a project with, in order to run the service.' },
            { p: 'You agree not to publish illegal or abusive content, content infringing the rights of others, or third-party personal data without the right to do so. It is forbidden to disrupt or overload the service, to bypass its limits or security measures, or to extract its data massively.' },
          ],
        },
        {
          heading: '5. Reporting and moderation',
          blocks: [
            { p: `Any content you consider illegal (in a shared project or a comment) can be reported to ${contact}, stating the project or comment concerned and the reason for the report. We examine each report diligently, tell you what action was taken, and give reasons for any removal or restriction decision to the author of the content, who can contest it the same way (Regulation (EU) 2022/2065 on digital services, articles 14, 16 and 17).` },
          ],
        },
        {
          heading: '6. Shared projects',
          blocks: [
            { p: 'The owner of a project can invite other RedView accounts to edit it, and remove their access at any time. Invited people see the project, its comments and the names of the other editors. The owner remains responsible for the project and can delete it.' },
          ],
        },
        {
          heading: '7. Paid subscription',
          blocks: [
            {
              ul: [
                'Plans, prices including VAT: 1 month at €14.90, 6 months at €70, 1 year at €119. The applicable price is the one displayed at the time of subscription.',
                '7-day free trial on the first subscription of an account, once only; a payment method is requested up front and the first charge happens at the end of the trial, unless cancelled before.',
                'The subscription renews automatically for the same duration. For the 6-month and 1-year plans, we notify you by email before each renewal (article L.215-1 of the French Consumer Code).',
                'Cancellation at any time in the application (Subscription → Cancel your contract): it takes effect at the end of the current period, with no further charge.',
                'Payment is processed by Stripe; RedView never has access to your card details.',
              ],
            },
          ],
        },
        {
          heading: '8. Right of withdrawal',
          blocks: [
            { p: 'If you are a consumer, you have 14 days from subscription to withdraw, without giving any reason, by writing to the contact address. If you asked to use the service before the end of that period, the amount corresponding to the service provided until your withdrawal remains due (articles L.221-18 and L.221-25 of the French Consumer Code); the rest is refunded within 14 days.' },
          ],
        },
        {
          heading: '9. Availability and liability',
          blocks: [
            { p: 'We do our best to keep the service available and reliable, without being able to guarantee continuous availability, in particular during maintenance. Imported data is backed up every night; we recommend keeping your own copies (GPX export, .redview project file).' },
            { p: 'We cannot be held liable for the consequences of using the information provided by the service (§ 3), nor for interruptions caused by third parties (data providers, network). Nothing in these terms limits the rights you have by law as a consumer.' },
          ],
        },
        {
          heading: '10. Intellectual property and third-party data',
          blocks: [
            { p: `The service and its components are the property of ${editor}. Map and geographic data come from third parties (OpenStreetMap, IGN, Météo-France, swisstopo…) under their own licences, whose attributions are in Settings → Data sources.` },
          ],
        },
        {
          heading: '11. Suspension and closure of the account',
          blocks: [
            { p: 'You can delete your account at any time (Account → Your data). We may suspend or close an account that seriously breaches these terms, after informing you of the reason, except in an emergency or where the law requires otherwise.' },
          ],
        },
        {
          heading: '12. Changes to the terms',
          blocks: [
            { p: 'We may change these terms. You will be informed of any significant change at least 30 days before it takes effect; if you refuse it, you can cancel your subscription and delete your account.' },
          ],
        },
        {
          heading: '13. Governing law and disputes',
          blocks: [
            { p: `These terms are governed by French law. In case of a dispute, contact us first at ${contact}. If you are a consumer, you can use the consumer mediator free of charge: ${v(publisher.consumerMediator)}, or the European online dispute resolution platform. Failing agreement, the French courts have jurisdiction, subject to the rules protecting consumers.` },
          ],
        },
      ],
    },

    accessibility: {
      title: 'Accessibility statement',
      lead: `${editor} is committed to making the RedView service accessible. This statement applies to app.redview.tech. ${prevails}`,
      sections: [
        {
          heading: 'Compliance status',
          blocks: [
            { p: 'RedView partially complies with WCAG 2.2 level A and AA criteria. No external audit has been carried out yet.' },
          ],
        },
        {
          heading: 'Checks carried out',
          blocks: [
            { p: 'With every release, an automated test (axe-core, WCAG 2.0 to 2.2 A and AA criteria) goes through the main screens — sign-in, projects, editor, exports, map tools, comments, settings, sharing, account, account deletion — as well as the LiDAR viewer and its menu: no defect found. The main map tools can be reached and activated with the keyboard, with a visible focus outline.' },
          ],
        },
        {
          heading: 'Non-accessible content',
          blocks: [
            { p: 'The 3D map and the LiDAR viewer are graphic renderings (WebGL, WebGPU) without a complete text alternative; the elevation profile and the route schedule provide part of it as values. Drawing a route with the mouse has no complete keyboard equivalent; a GPX file can be imported instead.' },
          ],
        },
        {
          heading: 'Feedback and contact',
          blocks: [
            { p: `If you cannot access some content or feature, write to us at ${contact}: we will offer a solution or the content in another form.` },
          ],
        },
        {
          heading: 'Remedies',
          blocks: [
            { p: 'If your request does not receive a satisfactory answer, you can refer the matter to the French Défenseur des droits ([www.defenseurdesdroits.fr](https://www.defenseurdesdroits.fr)).' },
          ],
        },
      ],
    },
  };
}
