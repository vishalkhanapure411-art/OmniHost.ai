import { enIN, type MessageKey } from "~/i18n/catalog-en";

/**
 * The second catalog, and the two generated ones.
 *
 * `hiIN` is hand-written and deliberately partial: Hindi (India) is the first
 * non-English catalog, and a partial catalog is the *normal* state of a product being
 * translated — a key that is not translated yet falls back to English rather than
 * rendering as `chains.list.title` or as an empty box. The coverage is not hidden; the
 * language switcher and the design gallery both report it
 * (`common.language.coverage`), because "half the screen is English" is a decision a
 * reviewer should see, not discover.
 *
 * The two pseudo-locales are generated from the English source so they can never drift
 * out of sync with it:
 *   * `ar-XB` mirrors to right-to-left — the layout test. The transform maps ASCII to
 *     a mixed set and swaps the bracket characters so a mis-ordered string is visible.
 *   * `en-XA` pads every string by ~40% — the expansion test. German, French, Finnish
 *     and Arabic run materially longer than English, so a fixed-width button or a
 *     single-line truncation on a critical label shows up here rather than in a
 *     translation review six weeks before go-live.
 */

/** Hand-written Hindi. Keys not listed here resolve to the English source string. */
export const hiIN: Partial<Record<MessageKey, string>> = {
  // Platform
  "app.tagline": "संचालन कंसोल",
  "app.skipToContent": "मुख्य सामग्री पर जाएँ",
  "app.phase": "चरण 0 · प्लेटफ़ॉर्म आधार",

  // Actions
  "action.save": "सहेजें",
  "action.cancel": "रद्द करें",
  "action.close": "बंद करें",
  "action.confirm": "पुष्टि करें",
  "action.retry": "पुनः प्रयास करें",
  "action.refresh": "रीफ़्रेश करें",
  "action.search": "खोजें",
  "action.clear": "साफ़ करें",
  "action.clearFilters": "फ़िल्टर हटाएँ",
  "action.signOut": "साइन आउट",
  "action.signIn": "साइन इन",
  "action.signingIn": "साइन इन हो रहा है…",
  "action.review": "समीक्षा करें",
  "action.back": "वापस",
  "action.edit": "संपादित करें",
  "action.apply": "लागू करें",
  "action.dismiss": "खारिज करें",
  "action.open": "खोलें",
  "action.copy": "कॉपी करें",
  "action.copied": "कॉपी हो गया",

  // Labels
  "common.none": "—",
  "common.unknown": "अज्ञात",
  "common.required": "आवश्यक",
  "common.optional": "वैकल्पिक",
  "common.readOnly": "केवल पढ़ने के लिए",
  "common.loading": "लोड हो रहा है…",
  "common.search.placeholder": "खोजें",
  "common.filter": "फ़िल्टर",
  "common.density.label": "पंक्ति घनत्व",
  "common.density.compact": "सघन",
  "common.density.cozy": "सामान्य",
  "common.density.roomy": "खुला",
  "common.language.label": "भाषा",
  "common.language.aria": "इंटरफ़ेस भाषा",
  "common.language.preview": "पूर्वावलोकन",
  "common.language.coverage": "{total} में से {translated} संदेश अनूदित",
  "common.timezone.label": "समय इस क्षेत्र में",
  "common.currency.label": "डिफ़ॉल्ट मुद्रा",
  "common.count.one": "{count} आइटम",
  "common.count.other": "{count} आइटम",
  "common.showing": "{total} में से {shown} दिखाए जा रहे हैं",

  // Validation
  "validation.required": "{field} आवश्यक है।",
  "validation.tooShort": "{field} कम से कम {min} अक्षरों का होना चाहिए।",
  "validation.tooLong": "{field} {max} अक्षरों से अधिक नहीं होना चाहिए।",
  "validation.pattern": "{field} में केवल छोटे अक्षर, अंक और हाइफ़न हो सकते हैं।",
  "validation.taken": "{field} “{value}” पहले से प्रयोग में है।",
  "validation.summary.one": "आगे बढ़ने से पहले 1 फ़ील्ड ठीक करें।",
  "validation.summary.other": "आगे बढ़ने से पहले {count} फ़ील्ड ठीक करें।",

  // Errors and states
  "error.title": "यह लोड नहीं हुआ",
  "error.description":
    "सर्वर ने इस अनुरोध को अस्वीकार किया या वह विफल रहा। कुछ भी बदला नहीं गया। प्रयास ऑडिट लॉग में दर्ज है।",
  "error.network.description": "इस ब्राउज़र से सर्वर तक नहीं पहुँचा जा सका।",
  "error.forbidden.title": "अनुमति नहीं है",
  "error.forbidden.needs": "{permission} चाहिए, जो आपके रजिस्ट्री में नहीं है।",
  "error.notFound.title": "नहीं मिला",
  "error.notFound.description":
    "आपके दायरे में इस पहचान का कोई रिकॉर्ड नहीं है। वह हटा दिया गया हो सकता है, या किसी अन्य चेन का हो सकता है।",
  "state.empty.title": "यहाँ अभी कुछ नहीं है",
  "state.empty.description": "इस दायरे में दिखाने के लिए कुछ नहीं है।",
  "state.loading.title": "लोड हो रहा है",
  "state.noResults.title": "कोई मेल नहीं",
  "state.noResults.description": "“{query}” से कोई पंक्ति मेल नहीं खाती। सभी {total} देखने के लिए फ़िल्टर हटाएँ।",

  // Navigation
  "nav.section.aria": "कंसोल नेविगेशन",
  "nav.route./approvals": "स्वीकृतियाँ और कार्य",
  "nav.route./approvals.description": "आपकी भूमिकाओं को भेजे गए मेकर-चेकर आइटम।",
  "nav.route./chains": "चेन",
  "nav.route./chains.description": "चेन जोड़ें, लाइसेंस स्तर तय करें, सुविधाएँ चालू करें।",
  "nav.route./audit": "ऑडिट ट्रेल",
  "nav.route./audit.description": "किसने क्या किया, पहले और बाद की स्थिति के साथ।",
  "nav.route./design": "डिज़ाइन सिस्टम",
  "nav.route./design.description": "टोकन, कंपोनेंट और पैटर्न।",
  "nav.group.appLayer": "ऐप परत",
  "nav.group.platform": "प्लेटफ़ॉर्म",
  "nav.more": "अधिक",

  // Shell
  "shell.scope.app": "ऐप परत",
  "shell.scope.central": "केंद्रीय (हेड ऑफ़िस)",
  "shell.scope.site": "साइट",
  "shell.scope.label": "दायरा",
  "shell.roles.none": "कोई भूमिका नहीं",
  "shell.chain.label": "चेन",
  "shell.site.label": "साइट",
  "shell.permissions.title": "तय की गई अनुमतियाँ",
  "shell.permissions.count.one": "{count} टूल सर्वर-साइड तय",
  "shell.permissions.count.other": "{count} टूल सर्वर-साइड तय",
  "shell.permissions.show": "रजिस्ट्री दिखाएँ",
  "shell.permissions.hide": "रजिस्ट्री छिपाएँ",
  "shell.grants.title.one": "1 प्रत्यायित अनुमति के अधीन",
  "shell.grants.title.other": "{count} प्रत्यायित अनुमतियों के अधीन",
  "shell.grants.description":
    "भूमिका से नहीं, प्रत्यायन से मिली पहुँच। यहाँ नामित अनुमतियों तक सीमित और समय-बद्ध।",
  "shell.grants.line": "{reason} · {by} द्वारा दी गई · समाप्ति {when}",
  "shell.grants.noExpiry": "कोई समाप्ति नहीं",
  "shell.session.expires": "सत्र समाप्ति {when}",
  "shell.localeSource.user": "आपकी पसंद",
  "shell.localeSource.site": "इस साइट का डिफ़ॉल्ट",
  "shell.localeSource.chain": "इस चेन का डिफ़ॉल्ट",
  "shell.localeSource.platform": "प्लेटफ़ॉर्म डिफ़ॉल्ट",
  "shell.direction": "पाठ दिशा",
  "shell.direction.ltr": "बाएँ से दाएँ",
  "shell.direction.rtl": "दाएँ से बाएँ",

  // Sign in
  "login.eyebrow": "OmniHost.ai · सुरक्षित साइन-इन",
  "login.title": "साइन इन",
  "login.subtitle": "नेटिव यूज़रनेम और पासवर्ड। SSO प्रत्येक चेन के लिए AppConfig द्वारा कॉन्फ़िगर होता है।",
  "login.email.label": "ईमेल",
  "login.password.label": "पासवर्ड",
  "login.error.required": "अपना ईमेल और पासवर्ड दर्ज करें।",
  "login.error.invalid": "ईमेल या पासवर्ड ग़लत है।",
  "login.error.disabled": "यह खाता निष्क्रिय है।",
  "login.error.unreachable": "सर्वर तक नहीं पहुँचा जा सका।",
  "login.sso.note":
    "आप यहाँ साइन इन करें या अपनी चेन के आइडेंटिटी प्रोवाइडर से — भूमिका और अनुमति निर्धारण समान रहता है।",
  "login.demo.title": "तैयार डेमो खाते",
  "login.demo.subtitle":
    "डेमो डेटा। भूमिका बदलना वास्तविक है: प्रत्येक खाता सर्वर-साइड अलग टूल रजिस्ट्री पाता है।",
  "login.demo.column.account": "खाता",
  "login.demo.column.password": "पासवर्ड",
  "login.demo.column.role": "भूमिका",
  "login.demo.use": "इस खाते का उपयोग करें",
  "login.demo.hidden": "इस डिप्लॉयमेंट पर डेमो क्रेडेंशियल छिपे हैं।",
  "login.demo.warning":
    "यह अस्थायी क्रेडेंशियल केवल लॉन्च-पूर्व प्लेटफ़ॉर्म के लिए है, जिसमें कोई ग्राहक डेटा नहीं है। किसी वास्तविक चेन को जोड़ने से पहले इन्हें हटाना होगा।",

  // Landing
  "landing.eyebrow": "OmniHost.ai · {phase}",
  "landing.title": "प्लेटफ़ॉर्म का आधार, एक पूरी वर्टिकल स्लाइस के साथ",
  "landing.body":
    "मल्टी-आउटलेट होटल, रेस्तराँ, बार और QSR चेन के लिए AI-चैटबॉट-प्रथम संचालन प्लेटफ़ॉर्म। यही वह परत है जिस पर आगे की हर भूमिका-मॉड्यूल जुड़ेगा।",
  "landing.cta": "साइन इन",
  "landing.hint": "साइन-इन स्क्रीन पर डेमो खाते सूचीबद्ध हैं।",
  "landing.card.layers.title": "तीन परतें, एक मॉडल",
  "landing.card.layers.body":
    "ऐप (हमारे ऑपरेटर), केंद्रीय (चेन का हेड ऑफ़िस) और साइट (एक आउटलेट) स्कीमा में हैं, किसी स्क्रीन में नहीं।",
  "landing.card.permissions.title": "अनुमतियाँ सर्वर-साइड तय",
  "landing.card.permissions.body":
    "सत्र भूमिका असाइनमेंट और प्रत्यायन से टूल कोड निकालता है। इंटरफ़ेस उसी से बनता है; सर्वर उसे लागू करता है।",
  "landing.card.audit.title": "हर बदलाव ऑडिट-लॉग होता है",
  "landing.card.audit.body":
    "एक सहायक फ़ंक्शन कर्ता, भूमिका, चेन, साइट, क्रिया और पहले/बाद की स्थिति उसी ट्रांज़ैक्शन में दर्ज करता है — अस्वीकृत प्रयास भी।",
  "landing.card.i18n.title": "भारत-प्रथम, वैश्विक रोलआउट के लिए बना",
  "landing.card.i18n.body":
    "हर लेबल और संदेश कैटलॉग से आता है; मुद्रा राशि और ISO कोड है; समय दर्शक के क्षेत्र में; लेआउट दाएँ-से-बाएँ भाषाओं के लिए दर्पण होता है।",
  "landing.notBuilt":
    "जान-बूझकर अभी नहीं बना: चैटबॉट गेटवे, POS/KDS/CDS, ऑर्डर, भुगतान, FSSAI मेनू फ़ील्ड, मोबाइल ऐप और डिप्लॉयमेंट ऑटोमेशन। ये आगे के चरण हैं।",

  // Chains
  "chains.eyebrow": "ऐप परत · लाइसेंसिंग",
  "chains.title": "चेन",
  "chains.description":
    "टेनेंट जोड़ें, लाइसेंस स्तर तय करें और सुविधाएँ चालू करें। लाइसेंस स्तर प्रति चेन है — चेन की हर साइट एक ही स्तर पर चलती है।",
  "chains.list.title": "आपके दायरे की चेन",
  "chains.list.empty.title": "आपके दायरे में कोई चेन नहीं",
  "chains.list.empty.description":
    "प्रत्यायित AppConfig या AppSupport ऑपरेटर केवल वही चेन देखता है जो उसके ग्रांट में हैं — इसलिए यहाँ खाली सूची अनुमति मॉडल के सही काम करने का प्रमाण है।",
  "chains.column.chain": "चेन",
  "chains.column.tier": "स्तर",
  "chains.column.jurisdiction": "कर क्षेत्राधिकार",
  "chains.column.status": "स्थिति",
  "chains.column.sites": "साइट",
  "chains.column.features": "चालू सुविधाएँ",
  "chains.column.onboarded": "जोड़ा गया",
  "chains.tier.silver": "सिल्वर",
  "chains.tier.gold": "गोल्ड",
  "chains.tier.platinum": "प्लेटिनम",
  "chains.tier.help": "स्तर मॉड्यूल की गहराई और AI वेरिएंट तय करता है, भूमिकाएँ नहीं।",
  "chains.status.active": "सक्रिय",
  "chains.status.suspended": "निलंबित",
  "chains.status.pending": "लंबित",
  "chains.features.enabledOf": "{total} में से {enabled}",
  "chains.onboard.eyebrow": "ऐप परत · केवल AppAdmin",
  "chains.onboard.title": "चेन जोड़ें",
  "chains.onboard.description":
    "टेनेंट, उसका लाइसेंस स्तर और रजिस्ट्री की हर सुविधा के लिए एक पंक्ति, एक ही ऑडिटेड ट्रांज़ैक्शन में बनाता है।",
  "chains.onboard.section.identity": "टेनेंट पहचान",
  "chains.onboard.section.licence": "लाइसेंस और अनुपालन",
  "chains.onboard.section.features": "प्रारंभिक सुविधाएँ",
  "chains.onboard.name.label": "चेन का नाम",
  "chains.onboard.name.hint": "वह व्यापारिक नाम जो आपकी साइटें देखेंगी।",
  "chains.onboard.code.label": "चेन कोड",
  "chains.onboard.code.placeholder": "saffron-table",
  "chains.onboard.code.hint": "छोटे अक्षरों में स्लग, प्लेटफ़ॉर्म पर अद्वितीय। खाली छोड़ने पर नाम से बनेगा।",
  "chains.onboard.jurisdiction.label": "कर क्षेत्राधिकार",
  "chains.onboard.jurisdiction.hint": "ISO क्षेत्र, वैकल्पिक उप-विभाग के साथ (IN-KA)। GST/VAT और मेनू नियम तय करता है।",
  "chains.onboard.tier.label": "लाइसेंस स्तर",
  "chains.onboard.features.hint": "जो छोड़ा गया वह रजिस्ट्री डिफ़ॉल्ट पर रहेगा।",
  "chains.onboard.features.needsTier": "{tier} चाहिए",
  "chains.onboard.features.alwaysOn": "सदैव चालू",
  "chains.onboard.submit": "समीक्षा करें और जोड़ें",
  "chains.onboard.submitting": "जोड़ा जा रहा है…",
  "chains.onboard.denied.title": "चेन जोड़ना AppAdmin का कार्य है",
  "chains.onboard.denied.description":
    "आपके रजिस्ट्री में chain.list और chain.read है, पर chain.onboard नहीं — इसलिए यह फ़ॉर्म केवल पढ़ने के लिए है। सबमिट करने पर सर्वर 403 लौटाएगा और अस्वीकृति ऑडिट लॉग में दर्ज होगी।",
  "chains.onboard.review.title": "यह चेन जोड़ें?",
  "chains.onboard.review.body":
    "यह एक टेनेंट बनाएगा और पूरी सुविधा-सूची को बाद की स्थिति के रूप में ऑडिट प्रविष्टि में लिखेगा।",
  "chains.onboard.review.confirm": "चेन जोड़ें",
  "chains.onboard.success": "{name} {tier} स्तर पर जोड़ा गया।",
  "chains.detail.eyebrow": "ऐप परत · चेन कॉन्फ़िगरेशन",
  "chains.detail.titleFallback": "चेन",
  "chains.detail.description":
    "लाइसेंस स्तर, सुविधा टॉगल और साइटें। हर बदलाव सर्वर-साइड जाँचा जाता है और पहले/बाद की स्थिति के साथ ऑडिट लॉग में जाता है।",
  "chains.detail.tier.title": "लाइसेंस स्तर",
  "chains.detail.tier.subtitle": "प्रति चेन, कभी प्रति साइट नहीं।",
  "chains.detail.tier.confirmTitle": "लाइसेंस स्तर {tier} करें?",
  "chains.detail.tier.confirmBody":
    "{tier} से ऊपर की सुविधाएँ बंद हो जाएँगी और चेन की हर साइट प्रभावित होगी। यह आपके नाम पर दर्ज होगा।",
  "chains.detail.tier.confirmCta": "स्तर बदलें",
  "chains.detail.tier.sitesAffected.one": "1 साइट प्रभावित।",
  "chains.detail.tier.sitesAffected.other": "{count} साइटें प्रभावित।",
  "chains.detail.features.title": "सुविधा टॉगल",
  "chains.detail.features.subtitle.one": "{enabled} में से 1 सुविधा चालू।",
  "chains.detail.features.subtitle.other": "{total} में से {enabled} सुविधाएँ चालू।",
  "chains.detail.features.blocked": "{tier} स्तर चाहिए; यह चेन {current} पर है।",
  "chains.detail.features.availableFrom": "{tier} से उपलब्ध।",
  "chains.detail.features.toggleLabel": "{feature} चालू करें",
  "chains.detail.features.alwaysOn": "सदैव चालू",
  "chains.detail.features.column.feature": "सुविधा",
  "chains.detail.features.column.module": "मॉड्यूल",
  "chains.detail.features.column.minTier": "किस स्तर से",
  "chains.detail.features.column.lastChange": "अंतिम बदलाव",
  "chains.detail.features.column.enabled": "चालू",
  "chains.detail.sites.title": "साइट और आउटलेट",
  "chains.detail.sites.subtitle": "इस चेन के आज के ठिकाने, प्रत्येक साइट के अपने समय क्षेत्र के साथ।",
  "chains.detail.sites.empty.title": "अभी कोई साइट नहीं",
  "chains.detail.sites.empty.description": "साइट प्रबंधन अपने चरण में आएगा; यह चेन बिना साइट के जोड़ी गई।",
  "chains.detail.sites.column.site": "साइट",
  "chains.detail.sites.column.timezone": "समय क्षेत्र",
  "chains.detail.sites.column.outlets": "आउटलेट",
  "chains.detail.sites.column.status": "स्थिति",
  "chains.detail.notFound.title": "चेन उपलब्ध नहीं",
  "chains.detail.notFound.description":
    "यह चेन आपके दायरे में नहीं है। प्रत्यायन तय करता है कि आप किन चेन तक पहुँच सकते हैं।",

  // Approvals
  "approvals.eyebrow": "साझा इनबॉक्स",
  "approvals.title": "स्वीकृतियाँ और कार्य",
  "approvals.description":
    "आपकी भूमिकाओं को भेजे गए आइटम। मेकर-चेकर कार्य अनुमोदक के पास जाते हैं, अनुरोधकर्ता के पास वापस नहीं।",
  "approvals.queue.title": "आपकी प्रतीक्षा में",
  "approvals.queue.assignedTo": "{role} को सौंपा",
  "approvals.queue.unassigned": "असौंपा",
  "approvals.queue.due": "देय {when}",
  "approvals.queue.overdue": "विलंबित",
  "approvals.empty.title": "आपकी प्रतीक्षा में कुछ नहीं",
  "approvals.empty.description":
    "आपकी भूमिकाओं को अभी कोई मेकर-चेकर आइटम नहीं भेजा गया। माल-प्राप्ति, अपव्यय और धनवापसी के मॉड्यूल आने पर आइटम बनेंगे।",
  "approvals.how.title": "यह इनबॉक्स कैसे काम करता है",
  "approvals.how.subtitle": "स्पेक के मेकर-चेकर नियम से बना, किसी स्क्रीन डिज़ाइन से नहीं।",
  "approvals.column.item": "आइटम",
  "approvals.column.chain": "चेन",
  "approvals.column.category": "श्रेणी",
  "approvals.column.assignedRole": "निर्णय",
  "approvals.column.due": "देय",
  "severity.low": "कम",
  "severity.medium": "मध्यम",
  "severity.high": "उच्च",
  "severity.critical": "गंभीर",

  // Audit
  "audit.eyebrow": "नियंत्रण · पारदर्शिता",
  "audit.title": "ऑडिट ट्रेल",
  "audit.description":
    "कौन, किस भूमिका में, किस चेन और साइट पर, क्या क्रिया, और पहले/बाद की स्थिति — हर बदलाव के लिए एक ही सहायक फ़ंक्शन लिखता है।",
  "audit.list.title": "सबसे नए",
  "audit.list.count.one": "1 प्रविष्टि",
  "audit.list.count.other": "{count} प्रविष्टियाँ",
  "audit.column.when": "कब",
  "audit.column.actor": "कर्ता",
  "audit.column.action": "क्रिया",
  "audit.column.entity": "इकाई",
  "audit.column.outcome": "परिणाम",
  "audit.column.source": "स्रोत",
  "audit.column.stateChange": "स्थिति परिवर्तन",
  "audit.outcome.success": "सफल",
  "audit.outcome.denied": "अस्वीकृत",
  "audit.outcome.error": "विफल",
  "audit.source.screen": "स्क्रीन",
  "audit.source.chatbot": "चैटबॉट",
  "audit.source.api": "API",
  "audit.before": "पहले",
  "audit.after": "बाद",
  "audit.noChange": "कोई संग्रहीत परिवर्तन नहीं",
  "audit.intent": "चैटबॉट इंटेंट: {intent}",
  "audit.detail.title": "स्थिति परिवर्तन",
  "audit.detail.eyebrow": "पहले / बाद",
  "audit.detail.empty.description": "किसी बदलाव के बाद उसकी पहले/बाद स्थिति यहाँ दिखेगी।",
  "audit.empty.title": "अभी कुछ दर्ज नहीं",
  "audit.empty.description": "आपके दायरे में अभी कोई ऑडिट क्रिया दिखाई नहीं देती।",
  "audit.filter.search.placeholder": "क्रिया, कर्ता या इकाई से फ़िल्टर करें",
  "audit.filter.outcome.label": "परिणाम",
  "audit.filter.all": "सभी",
  "audit.platform": "प्लेटफ़ॉर्म-व्यापी",

  // A11y
  "a11y.sortedAscending": "आरोही क्रम",
  "a11y.sortedDescending": "अवरोही क्रम",
  "a11y.sortBy": "{column} से क्रमबद्ध करें",
  "a11y.queue": "स्वीकृति कतार",
  "a11y.masterPane": "सूची",
  "a11y.detailPane": "विवरण",
  "a11y.status": "स्थिति: {status}",
  "a11y.moneyAmount": "{amount} {currency}",

  // AppSupport vertical (Phase 0). Partial, like the rest of this catalog: an
  // untranslated key falls back to English and the coverage figure says so.
  "nav.route./support": "सहायता कतार",
  "nav.route./support.access": "सहायता पहुँच",
  "support.title": "सहायता कतार",
  "support.eyebrow": "ऐप परत · AppSupport",
  "support.column.reference": "टिकट",
  "support.column.subject": "विषय",
  "support.column.severity": "गंभीरता",
  "support.column.status": "स्थिति",
  "support.column.chain": "चेन",
  "support.column.assigned": "सौंपा गया",
  "support.column.due": "पहला उत्तर देय",
  "support.status.new": "नया",
  "support.status.triaged": "वर्गीकृत",
  "support.status.assigned": "सौंपा गया",
  "support.status.waiting": "चेन की प्रतीक्षा",
  "support.status.resolved": "हल किया गया",
  "support.status.closed": "बंद",
  "support.overdue": "प्रतिक्रिया समय सीमा बीत चुकी",
  "support.onTime": "एसएलए के भीतर",
  "support.detail.assignment.title": "कार्य सौंपना",
  "support.detail.resolve.title": "यह टिकट हल करें",
  "support.detail.resolve.note.label": "समाधान टिप्पणी",
  "support.detail.access.title": "चेन के भीतर कार्य",
  "support.detail.access.open": "सहायता पहुँच के अंतर्गत खोलें",
  "support.access.title": "समय-सीमित चेन पहुँच",
  "support.access.grants.title": "आपके पास मौजूद पहुँच",
  "support.access.requests.title": "अनुरोध",
  "support.access.request.title": "चेन तक पहुँच का अनुरोध करें",
  "support.access.column.requester": "अनुरोधकर्ता",
  "support.access.column.chain": "चेन",
  "support.access.column.reason": "कारण",
  "support.access.column.status": "स्थिति",
  "support.access.status.pending": "लंबित",
  "support.access.status.approved": "स्वीकृत",
  "support.access.status.denied": "अस्वीकृत",

  // AppConfig vertical (Phase 0).
  "nav.route./chains/$chainId/settings": "चेन कॉन्फ़िगरेशन",
  "config.eyebrow": "ऐप परत · AppConfig",
  "config.auth.title": "प्रमाणीकरण और एसएसओ",
  "config.auth.mode.label": "साइन-इन विधि",
  "config.auth.mode.native": "नेटिव उपयोगकर्ता नाम / पासवर्ड",
  "config.auth.mode.sso": "एसएसओ (SAML / OIDC)",
  "config.auth.protocol.label": "प्रोटोकॉल",
  "config.auth.submit": "समीक्षा करें और सहेजें",
  "config.settings.title": "प्रत्यायोजित चेन सेटिंग्स",
  "config.settings.column.setting": "सेटिंग",
  "config.settings.column.module": "मॉड्यूल",
  "config.settings.column.delegation": "कौन सेट कर सकता है",
  "config.settings.column.bounds": "सीमाएँ",
  "config.settings.column.value": "मान",
  "config.settings.delegation.chain_head": "चेन प्रशासक",
  "config.settings.delegation.site_head": "साइट प्रमुख",
  "config.settings.delegation.none": "केवल ऐप परत",
  "config.settings.fixed": "नीति द्वारा निर्धारित",
  "config.settings.unset": "डिफ़ॉल्ट",
  "config.settings.edit": "मान बदलें",
  "config.locale.title": "साइट भाषा डिफ़ॉल्ट",
  "config.locale.column.site": "साइट",
  "config.locale.column.locale": "डिफ़ॉल्ट भाषा",
  "config.locale.column.timezone": "समय क्षेत्र",
  "config.locale.inherit": "चेन का अनुसरण करें",
};

/** Latin → look-alike mapping used by the right-to-left layout test. */
const MIRROR: Record<string, string> = {
  a: "ɐ",
  b: "q",
  c: "ɔ",
  d: "p",
  e: "ǝ",
  f: "ɟ",
  g: "ƃ",
  h: "ɥ",
  i: "ᴉ",
  j: "ɾ",
  k: "ʞ",
  l: "ן",
  m: "ɯ",
  n: "u",
  o: "o",
  p: "d",
  q: "b",
  r: "ɹ",
  s: "s",
  t: "ʇ",
  u: "n",
  v: "ʌ",
  w: "ʍ",
  x: "x",
  y: "ʎ",
  z: "z",
  A: "∀",
  B: "ᗺ",
  C: "Ɔ",
  D: "ᗡ",
  E: "Ǝ",
  F: "Ⅎ",
  G: "⅁",
  H: "H",
  I: "I",
  J: "ſ",
  K: "ʞ",
  L: "˥",
  M: "W",
  N: "N",
  O: "O",
  P: "Ԁ",
  Q: "Ò",
  R: "ᴚ",
  S: "S",
  T: "┴",
  U: "∩",
  V: "Λ",
  W: "M",
  X: "X",
  Y: "⅄",
  Z: "Z",
  "[": "]",
  "]": "[",
  "(": ")",
  ")": "(",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
};

function mirrorText(value: string): string {
  let out = "";
  for (const char of value) out += MIRROR[char] ?? char;
  return out;
}

/** Pads a string to ~140% of its length, the way German or Finnish would. */
function expandText(value: string): string {
  return value
    .split(/(\s+)/)
    .map((chunk) => (/^\s*$/.test(chunk) ? chunk : `${chunk}·${chunk.length > 8 ? "··" : ""}`))
    .join("")
    .replace(/·+/g, "·")
    .slice(0, Math.ceil(value.length * 1.4) + 8);
}

/**
 * `ar-XB` — the seeded right-to-left layout pseudo-locale: mirrored glyphs, corrected
 * placeholder braces, direction `rtl`. Not a language, and labelled as such in the
 * switcher so nobody mistakes it for an Arabic translation.
 */
export const arXB: Record<MessageKey, string> = Object.fromEntries(
  Object.entries(enIN).map(([key, value]) => [key, mirrorText(value as string)])
) as Record<MessageKey, string>;

/** `en-XA` — the text-expansion pseudo-locale. */
export const enXA: Record<MessageKey, string> = Object.fromEntries(
  Object.entries(enIN).map(([key, value]) => [key, expandText(value as string)])
) as Record<MessageKey, string>;

export type Catalog = Partial<Record<MessageKey, string>>;
