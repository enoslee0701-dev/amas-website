/* AMAS 清迈神学院 — 由 tools/build-web.ps1 从 src/work.html 生成，勿直接编辑 */

/* =========================================================================
   站点配置 —— 上线前主要改这里
   ========================================================================= */
const CONFIG = {
  /* 表单提交地址。
     留空("")= 演示模式：申请与咨询只存在访客自己的浏览器 localStorage 里，
     学校收不到任何资料。正式上线前必须填。
     可直接用接受 JSON POST 的托管服务，例如 Formspree：
       formEndpoint: "https://formspree.io/f/xxxxxxxx"
     也可以填自建后端的 API 地址。 */
  formEndpoint: "https://formsubmit.co/ajax/amasthai2026@gmail.com",

  /* 请求头。自建后端若需要鉴权，在这里加 Authorization 等字段。 */
  formHeaders: { "Content-Type": "application/json", "Accept": "application/json" },

  /* 介绍视频地址。留空则弹窗继续显示占位说明。
     支持 YouTube / Vimeo 的 embed 链接，或以 .mp4 结尾的直链。
       videoUrl: "https://www.youtube.com/embed/XXXXXXXXXXX"  */
  videoUrl: "",

  /* 真实的下载文件地址。留空则沿用演示用的占位 .txt。
     单文件部署时也可以直接塞 data:application/pdf;base64,... （会显著增大文件体积）。 */
  resources: {
    "student-handbook": "assets/files/AMAS-student-handbook.pdf",   // 新生入学手册 PDF
    "curriculum": "assets/files/AMAS-BTh-curriculum.pdf"            // B.Th 课程目录 PDF
  },

  /* 联系方式：填了才会显示在「联系我们」里，留空的不会出现空行。 */
  contact: {
    email:   "amasthai2026@gmail.com",
    line:    "enoslee0701",
    wechat:  "L52586222",
    phone:   "+66 093 623 0780",      // 泰国
    phoneCN: "+86 187 1445 4664"      // 中国
  },

  /* AI 客服（可选）。留空 = 只用内置知识库应答（零依赖，够用）。
     想接真实大模型：自建一个代理接口，接受 POST {messages:[{role,content}...]}，
     返回 {reply:"..."}，把地址填在这里（务必在代理侧保管 API Key，不要放前端）。
     接口报错时会自动回退到内置知识库。 */
  ai: {
    endpoint: "",
    headers: { "Content-Type": "application/json" }
  }
};

/* ========================================================================= */

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => (
  { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
));

/* ===== 白日 / 夜晚主题 =====
   初始值已由 <head> 里的内联脚本设定，这里只负责后续切换，
   避免在页面加载时把「跟随系统」误写成固定偏好。 */
const themeToggle = $("#themeToggle");
let currentTheme = document.documentElement.dataset.theme === "night" ? "night" : "day";

function applyTheme(theme, { persist = true, announce = false } = {}){
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  if(persist){ try{ localStorage.setItem("amas-theme", theme); }catch(e){} }
  if(themeToggle){
    const isNight = theme === "night";
    themeToggle.setAttribute("aria-pressed", isNight ? "true" : "false");
    themeToggle.setAttribute("aria-label", t(isNight ? "a11y.themeToDay" : "a11y.themeToNight"));
    themeToggle.title = t(isNight ? "a11y.themeDay" : "a11y.themeNight");
  }
  if(announce) toast(t(theme === "night" ? "toast.themeNight" : "toast.themeDay"));
}
themeToggle?.addEventListener("click", () =>
  applyTheme(currentTheme === "night" ? "day" : "night", { announce: true })
);

// 访客没手动选过主题时，跟随系统切换
try{
  if(!localStorage.getItem("amas-theme")){
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e =>
      applyTheme(e.matches ? "night" : "day", { persist: false })
    );
  }
}catch(e){}


/* ===== 多语言 ===== */
const i18n = {
 zh: {
  "chat.open":"打开在线咨询","chat.title":"招生咨询助手","chat.subtitle":"即时解答 · 可留言给招生同工","chat.placeholder":"输入问题…","chat.send":"发送","chat.note":"自动应答基于本站信息；留言将转交招生同工回复。",
  "chat.greeting":"平安！我是亚洲宣教神学院（AMAS）招生咨询助手，可以回答报名、学费、课程等问题；也可以直接给招生同工留言。想了解什么？","chat.fallback":"这个问题我暂时没有确切答案，建议留言给招生同工，他们会尽快回复你。",
  "chat.chips.apply":"如何报名？","chat.chips.tuition":"学费多少？","chat.chips.courses":"有哪些课程？","chat.chips.mode":"怎么上课？","chat.chips.leave":"给招生老师留言",
  "chat.kb.apply":"点击「申请入学」填写在线申请（约 3 分钟），提交后招生同工会主动联系你说明后续步骤；也可以在资源中心下载完整版 Word 申请表。",
  "chat.kb.tuition":"学费采用按科修读、按科缴费的方式，具体金额请亲自向招生同工咨询；经济上有困难的学员可说明情况，申请学费减免、分期或其他学习支持。","chat.kb.tuitionBtn":"查看学费与支持",
  "chat.kb.courses":"课程以圣经、神学、事工实践与生命塑造为主轴，目前站内列出 10 门课程，含使徒行传与宣教、哥林多前书等。","chat.kb.coursesBtn":"浏览课程",
  "chat.kb.programs":"从大学文凭（DIP）到博士（D.Min / D.Miss）共 8 个培养项目；2026 年 9 月2026 届开放 B.Th 神学学士招生。","chat.kb.programsBtn":"查看培养项目",
  "chat.kb.mode":"线上 + 线下灵活学习：线上课程为主，鼓励参与清迈线下门训与实践。2026 届 B.Th 于 2026 年 9 月 1 日开学。",
  "chat.kb.contact":"可以通过以下方式联系我们：","chat.kb.contactEmpty":"联系方式即将公布；现在可以直接在这里留言，或用页面底部的咨询表单，招生同工会主动联系你。",
  "chat.kb.location":"学院教学中心位于泰国清迈（Chiang Mai, Thailand），同时提供线上学习。",
  "chat.kb.video":"我们准备了学院介绍视频，可以点击观看。",
  "chat.leave.askName":"好的，我来帮你转达。请问怎么称呼你？","chat.leave.askContact":"留下你的联系方式（微信 / 邮箱 / 电话均可）：","chat.leave.askContent":"想对招生同工说什么？请输入留言内容：",
  "chat.leave.done":"留言已送出，招生同工会尽快回复你。还有其他问题吗？","chat.leave.doneDemo":"留言已保存（当前为演示模式，正式上线后将直达招生同工）。还有其他问题吗？","chat.leave.fail":"抱歉，留言发送失败，请稍后再试，或使用页面底部的咨询表单。",
  "brand.sub":"亚洲宣教神学院 · 清迈教学中心","brand.center":"清迈教学中心","brand.zoom":"查看校标大图","brand.sealSub":"AMAS 亚洲宣教神学院 · 泰国",
  "announce.brand":"AMAS 亚洲宣教神学院 · 清迈教学中心","announce.hot":"2026 届神学学士 B.Th 招生","announce.link":"查看招生信息 →",
  "nav.home":"首页","nav.about":"关于我们","nav.courses":"课程设置","nav.admissions":"招生信息","nav.tuition":"学费与支持","nav.life":"学院生活","nav.resources":"资源中心","nav.contact":"联系我们",
  "actions.apply":"申请入学","actions.login":"登录","actions.learn":"了解更多","actions.video":"观看介绍视频","actions.applyNow":"立即申请","actions.download":"下载 ↓","actions.view":"查看 →","actions.fill":"填写 →","actions.skip":"跳到主要内容","actions.backToTop":"↑ 顶部","actions.close":"关闭","actions.sending":"提交中…",
  "a11y.themeToNight":"切换到夜晚模式","a11y.themeToDay":"切换到白日模式","a11y.themeNight":"夜晚模式","a11y.themeDay":"白日模式","a11y.langSwitch":"切换语言（当前中文）","a11y.openMenu":"打开菜单","a11y.closeMenu":"关闭菜单",
  "toast.themeNight":"已切换为夜晚模式","toast.themeDay":"已切换为白日模式","toast.applied":"申请资料已送出","toast.appliedDemo":"申请资料已提交（演示）","toast.inquiry":"咨询已送出","toast.inquiryDemo":"咨询已提交（演示）","toast.failed":"提交失败，请稍后再试","toast.downloaded":"已下载占位文件",
  "meta.credits":"{n} 学分","meta.weeks":"{n} 周",
  "hero.title":"亚洲宣教神学院","hero.sub":"ASIA MISSIONARY ASSOCIATION SEMINARY","hero.verse":"你们要去，使万民作我的门徒。","hero.verseRef":"— 马太福音 28:19",
  "herometa.program":"项目","herometa.programVal":"神学学士 B.Th","herometa.start":"2026 届开学","herometa.mode":"学习","herometa.modeVal":"线上 + 线下",
  "accred.more":"查看认证详情 →","accred.title":"学术认证与资质","accred.intro":"AMAS 的以下学位课程已通过 Asia Theological Association (ATA) 的认证评估。","accred.bthName":"神学学士 Bachelor of Theology (B.Th.)","accred.mdivName":"道学硕士 Master of Divinity (M.Div.)","accred.dminName":"教牧学博士 Doctor of Ministry (D.Min.)","accred.bthNote":"经 Asia Theological Association (ATA) 认证","accred.note":"ATA 认证适用于上述列明的学位项目；认证范围与有效期以 ATA 出具的认证文件为准。",
  "actions.consult":"咨询招生","actions.applyBth":"申请神学学士 B.Th",
  "band.status":"总校审核并建立正式学籍","band.mode":"线上课程 + 清迈线下训练","band.adm":"2026 届神学学士 B.Th 招生",
  "admissions.facts.startLabel":"开学","admissions.facts.startValue":"2026 年 9 月 1 日","admissions.facts.feeLabel":"费用","admissions.facts.feeValue":"欢迎咨询招生同工","admissions.facts.modeLabel":"模式","admissions.facts.modeValue":"线上 + 线下","admissions.facts.statusLabel":"学籍","admissions.facts.statusValue":"总校审核建立",
  "admissions.consultBtn":"先咨询，30 秒","admissions.applyBtn":"正式申请",
  "admissions.path.title1":"初次了解 AMAS？","admissions.path.title2":"从一次轻松的咨询开始。","admissions.path.s1":"快速咨询","admissions.path.s1d":"姓名 + 联系方式 + 城市 + 想了解什么","admissions.path.s2":"招生同工沟通","admissions.path.s2d":"确认课程、学籍、时间与适合程度","admissions.path.s3":"正式申请","admissions.path.s3d":"再填写完整信仰与服事资料",
  "about.title":"AMAS 亚洲宣教神学院<br>植根圣经 · 面向世界","about.body":"我们致力于以圣经真理为根基，结合跨文化视野与实践训练，装备学生成为忠心的传道人、牧者与宣教工人，在教会与世界中活出福音，见证神的国度。","about.link":"了解我们的异象与使命",
  "pillars.bible.title":"圣经为本","pillars.bible.body":"坚守圣经权威，深化真理根基，培养扎实的神学思考与属灵洞见。",
  "pillars.practice.title":"实践导向","pillars.practice.body":"理论与实践并重，课堂与事奉结合，装备学以致用的服侍能力。",
  "pillars.mission.title":"宣教视野","pillars.mission.body":"放眼全球，跨文化装备，回应大使命的呼召。",
  "pillars.life.title":"生命塑造","pillars.life.body":"注重属灵生命与品格塑造，成为合神心意的工人。",
  "stats.courses":"课程与选修科目","stats.flex.title":"灵活学习","stats.flex.body":"线上线下同步学习","stats.global.title":"全球视野","stats.global.body":"跨文化学习与宣教网络","stats.team.title":"牧者团队","stats.team.body":"资深牧者与教师同行","stats.year":"2026 届神学学士 B.Th 招生启动",
  "mission.aria":"异象与使命","mission.title":"不是只完成课程，<br>而是被装备去服事。","mission.desc":"我们把神学教育放回真实的教会、家庭、职场与宣教现场，让知识、生命与行动彼此连接。",
  "mission.vision.0":"培养通过神的话语和圣灵能力得到装备的牧者和宣教士。","mission.vision.1":"在亚洲国家建立通过神的话语和圣灵能力得到装备的宣教中心。","mission.vision.2":"在亚洲国家建立重视圣经和实践的神学校，培养该国本土牧者和工人。",
  "mission.items.0.title":"扎根真理","mission.items.0.body":"建立可靠的圣经诠释与神学基础。","mission.items.1.title":"塑造生命","mission.items.1.body":"以属灵操练、群体关系与品格成长为核心。","mission.items.2.title":"训练实践","mission.items.2.body":"把所学转化为讲道、牧养、门训与服事能力。","mission.items.3.title":"回应使命","mission.items.3.body":"勇于传福音，并装备跨文化宣教的视野与能力。",
  "courses.title":"课程设置","courses.desc":"以圣经、神学、事工实践与生命塑造为主轴，兼顾线上学习与线下训练。","courses.filterGroup":"课程筛选","courses.filters.all":"全部","courses.filters.bible":"圣经","courses.filters.theology":"神学","courses.filters.ministry":"实践事工","courses.filters.mission":"宣教","courses.filters.formation":"生命塑造","courses.count":"已显示 {n} 门课程","courses.more":"展开全部课程（还有 {n} 门）","courses.less":"收起课程列表",
  "courseCards.0.title":"圣经综合概观","courseCards.0.body":"纵览全本圣经的结构、脉络与救赎主线。","courseCards.1.title":"马太福音","courseCards.1.body":"研读天国的信息，认识君王基督与门徒之道。","courseCards.2.title":"约翰福音","courseCards.2.body":"认识耶稣的身份与工作，因信祂的名得生命。","courseCards.3.title":"使徒行传","courseCards.3.body":"跟随初代教会的脚踪，看福音从耶路撒冷直到地极。","courseCards.4.title":"罗马书","courseCards.4.body":"系统研读因信称义的福音大纲与新生命之道。","courseCards.5.title":"哥林多前书","courseCards.5.body":"围绕教会秩序、十字架神学与群体建造研读书信。","courseCards.6.title":"哥林多后书","courseCards.6.body":"在软弱中认识神的安慰、能力与事奉者的职分。","courseCards.7.title":"以弗所书","courseCards.7.body":"认识教会作为基督身体的奥秘与在基督里的新生活。","courseCards.8.title":"希伯来书","courseCards.8.body":"仰望更美的大祭司基督，持定所承认的指望。","courseCards.9.title":"启示录","courseCards.9.body":"从启示文学认识终末盼望与教会的得胜。",
  "courseCards.10.title":"系统神学","courseCards.10.body":"面向平信徒与初阶学员的教义总览，建立信仰框架。","courseCards.11.title":"处境化神学","courseCards.11.body":"在亚洲处境中忠于圣经地思考、表达与实践信仰。","courseCards.12.title":"传道法","courseCards.12.body":"掌握传福音的信息、方法与陪谈跟进之道。","courseCards.13.title":"协谈学","courseCards.13.body":"学习倾听、辅导与属灵陪伴的基本功。","courseCards.14.title":"小组运营","courseCards.14.body":"建立、带领与倍增健康的小组群体。","courseCards.15.title":"新信徒事工","courseCards.15.body":"以系统教材陪伴初信者扎根信仰、融入教会。","courseCards.16.title":"教会运营","courseCards.16.body":"从治理、同工配搭到事工规划的教会运营实务。","courseCards.17.title":"礼拜顺序","courseCards.17.body":"认识崇拜的圣经意义与礼拜程序的安排。","courseCards.18.title":"内在医治","courseCards.18.body":"在真理与圣灵里经历内心创伤的医治与释放。","courseCards.19.title":"医治疾病","courseCards.19.body":"从圣经根基认识医治祷告的原则与实践。","courseCards.20.title":"宣告神话语的医治","courseCards.20.body":"学习以神的话语宣告、代祷并牧养病痛中的人。","courseCards.21.title":"属灵争战","courseCards.21.body":"认识属灵争战的圣经原则，穿戴神所赐的全副军装。","courseCards.22.title":"基督徒生活","courseCards.22.body":"在日常生活中操练信仰、敬虔与见证。","courseCards.23.title":"门徒生活","courseCards.23.body":"以门徒的身份跟随基督，建立稳定的生命节奏。","courseCards.24.title":"确信生活","courseCards.24.body":"建立救恩确据，活出稳固而有盼望的信仰根基。",
  "programs.title":"培养项目","programs.desc":"从装备课程到博士研究，完整的阶梯式培养路径；2026 届 B.Th 招生已开放，其余项目按批次开放。",
  "programs.degree.title":"学位课程","programs.degree.sub":"按学术阶梯逐级修读，学籍由 AMAS 总校审核建立","programs.equip.title":"装备课程","programs.equip.sub":"面向在职牧者与平信徒的短期训练",
  "programs.items.dip.name":"大学文凭课程","programs.items.dip.desc":"神学基础装备，进入学位课程的预备阶段",
  "programs.items.bth.name":"神学学士","programs.items.bth.desc":"2026 届招生 · 2026 年 9 月开学 · 线上 + 线下灵活学习",
  "programs.items.gdip.name":"研究生文凭","programs.items.gdip.desc":"面向已有学士学位者的神学研究入门",
  "programs.items.mdiv.name":"道学硕士","programs.items.mdiv.desc":"面向全职事奉的完整神学与教牧装备",
  "programs.items.dmin.name":"教牧学博士 / 宣教学博士","programs.items.dmin.desc":"D.Min / D.Miss，深化教牧与宣教的研究与实践",
  "programs.items.pastor.badge":"进修","programs.items.pastor.name":"牧会者进修","programs.items.pastor.desc":"在职牧者的持续装备与更新",
  "programs.items.preaching.badge":"讲道","programs.items.preaching.name":"讲道学校","programs.items.preaching.desc":"从释经到宣讲的集中训练",
  "programs.items.missionary.badge":"宣教","programs.items.missionary.name":"宣教士训练","programs.items.missionary.desc":"跨文化事奉的呼召分辨与差派预备",
  "programs.note":"各项目的开课批次、修读年限与申请条件，请通过「申请入学」或联系方式咨询招生同工。",
  "nav.programs":"培养项目",
  "digital.title":"数字校园","digital.desc":"学院正在建设自己的学习平台，把课程、资源与群体连接在同一个入口。",
  "digital.items.0.title":"远程课堂","digital.items.0.body":"正在修读的课程、直播讲座与课后回放汇总到一个入口，适合移动端连续学习。",
  "digital.items.1.title":"图书馆资源","digital.items.1.body":"讲义、音频与研究资料在图书馆与课程资料页同步出现，减少来回查找。",
  "digital.items.2.title":"校友社群","digital.items.2.body":"讨论、代祷、导师反馈与语音房，让学习与群体生活彼此连接。",
  "digital.note.label":"开发中：","digital.note.body":"学习 App 正在内部测试，正式发布后将在此提供下载入口。",
  "meta.lessons":"{n} 讲",
  "admissions.title":"2026 届神学学士 B.Th 招生","admissions.desc":"为愿意认真装备、持续成长并参与服事的人提供灵活、实践导向的神学教育路径。","admissions.points.0":"线上 + 线下灵活学习","admissions.points.1":"学费欢迎咨询","admissions.points.2":"2026 年 9 月开学","admissions.points.3":"总校审核并建立正式学籍","admissions.card.mode":"学习模式","admissions.card.modeValue":"线上 / 线下","admissions.card.start":"开学时间","admissions.card.location":"教学中心","admissions.card.locationValue":"清迈","admissions.card.language":"主要语言","admissions.card.languageValue":"中文",
  "tuition.title":"学费与学习支持","tuition.motto":"让愿意接受装备的人，都有继续学习的道路。","tuition.mode":"按科修读 · 按科缴费",
  "tuition.p1":"AMAS 采用按科修读、按科缴费的方式。学员根据自己的学习进度选修课程，不需要一次承担整学期或整学年的费用，让学习安排更加灵活，也减轻一次性经济压力。具体课程费用，请亲自向招生同工咨询了解。",
  "tuition.p2":"我们相信，神学装备需要学员认真投入，也需要学校、教师与服事团队共同承担教学成本。因此，正常缴纳课程费用，是对学习的委身，也是对教学事工的支持。",
  "tuition.v1":"“人若有愿作的心，必蒙悦纳，乃是照他所有的，并不是照他所无的。”","tuition.v1ref":"—— 哥林多后书 8:12",
  "tuition.p3":"因此，经济上的困难不应成为一个人接受神学装备的拦阻。对于确有经济困难、但愿意认真学习并接受装备的学员，可以主动向招生或教务同工说明实际情况，学校会根据个人情况，提供适当的学费减免、分期缴费或其他学习支持方案。",
  "tuition.p4":"我们的原则不是简单地“降低学费”，而是希望每一位真正愿意学习的人，都能够找到一条可以继续装备的道路。",
  "tuition.v2":"“在道理上受教的，当把一切需用的供给施教的人。”","tuition.v2ref":"—— 加拉太书 6:6",
  "tuition.p5":"AMAS 盼望建立健康的学习文化：有能力的学员正常承担学费；有困难的学员可以获得帮助；有余力的人也可以通过奉献支持其他学员接受装备。",
  "tuition.ctaFee":"了解课程费用","tuition.ctaAid":"申请学习支持",
  "tuition.pr.title":"学费原则","tuition.pr.0":"课程费用按科计算，具体金额请亲自咨询招生同工","tuition.pr.1":"按科缴费，不要求一次缴清全年费用","tuition.pr.2":"经济困难者可申请个别评估与学习支持","tuition.pr.3":"学校不会单纯因为经济困难而拒绝一个认真寻求装备的学员","tuition.pr.4":"具体减免、分期及支持方式由学校个别沟通决定",
  "life.title":"学习不是孤立发生的。","life.desc":"课堂、门训、小组、教会服事与真实生活共同构成神学教育。","life.items.0.title":"导师同行","life.items.0.body":"课程之外，重视生命陪伴与方向辨识。","life.items.0.p0":"定期的一对一生命陪伴与代祷","life.items.0.p1":"学习方向与服事召命的辨识","life.items.0.p2":"与资深牧者同行的属灵网络","life.items.1.title":"小组学习","life.items.1.body":"透过讨论、案例与彼此回应深化学习。","life.items.1.p0":"固定学习小组，彼此守望同行","life.items.1.p1":"课程讨论、案例分享与彼此回应","life.items.1.p2":"跨地区学员的线上团契生活","life.items.2.title":"实践服事","life.items.2.body":"把所学带入教会、家庭、职场与宣教现场。","life.items.2.p0":"与本地教会配搭的服事岗位","life.items.2.p1":"传道、门训、探访等实践安排","life.items.2.p2":"清迈线下密集训练与实践周","life.items.3.title":"敬拜与灵修","life.items.3.body":"在敬拜与祷告中扎根，生命先于事奉。","life.items.3.p0":"规律的灵修与祷告操练","life.items.3.p1":"参与崇拜聚会与礼拜服事","life.items.3.p2":"在群体中培养敬虔与品格",
  "life.rhythm.title":"每周学习节奏","life.rhythm.0":"线上课程与阅读作业","life.rhythm.1":"小组讨论与彼此回应","life.rhythm.2":"门训与导师时间","life.rhythm.3":"教会服事与生活实践",
  "resources.title":"资源中心","resources.searchLabel":"搜索资源","resources.searchPlaceholder":"搜索资源…","resources.count":"找到 {n} 项资源","resources.items.0":"新生入学手册","resources.items.1":"B.Th 课程目录","resources.items.2":"学费与学习支持","resources.items.3":"在线申请（快速通道）","resources.items.4":"入学申请表（完整版 Word）","resources.items.5":"上传已填写的申请表","actions.upload":"上传 ↑","upload.name":"姓名","upload.contact":"联系方式（邮箱 / 微信 / 电话）","upload.file":"选择已填写的申请表（Word 或 PDF）","upload.submit":"上传并提交","upload.note":"资料将直接发送至招生同工邮箱；提交后会在新页面显示确认。",
  "faq.title":"常见问题","faq.items.0.q":"没有神学背景可以申请吗？","faq.items.0.a":"可以。我们更看重持续学习、遵守学习纪律与认真接受装备的意愿。","faq.items.1.q":"课程全部线上吗？","faq.items.1.a":"以灵活学习为原则，包含线上课程，同时鼓励参与清迈线下门训、实践与群体学习。","faq.items.2.q":"完成后由谁建立学籍和颁发学位？","faq.items.2.a":"学籍由 AMAS 总校审核建立，并按学校正式制度完成毕业与学位流程。","faq.items.3.q":"如何开始申请？","faq.items.3.a":"点击“申请入学”，填写基础资料与学习动机，之后由招生同工联络并说明下一步。",
  "faq.ask.title":"还有其他问题？","faq.ask.desc":"AI 咨询助手可以随时解答；也可以直接留言给招生同工，我们会尽快回复你。","faq.ask.ai":"问 AI 咨询助手","faq.ask.leave":"给招生同工留言",
  "contact.title":"想进一步了解？","contact.desc":"留下你的问题，我们会通过你提供的联系方式回复。","contact.locationLabel":"地区","contact.studyLabel":"学习","contact.studyValue":"线上 + 线下","contact.emailLabel":"邮箱","contact.phoneLabel":"电话（泰国）","contact.phoneCNLabel":"电话（中国）","contact.lineLabel":"Line","contact.wechatLabel":"微信",
  "form.name":"姓名","form.contact":"邮箱 / Line / 微信","form.message":"想咨询的内容","form.send":"发送咨询",
  "form.okDemo":"已收到。当前演示版将咨询保存在本机浏览器中。","form.ok":"已收到，我们会尽快通过你留下的方式联络你。","form.error":"提交失败：网络或服务器异常，请稍后再试，或直接与我们联系。",
  "video.title":"学院介绍视频","video.placeholder":"这里已经预留视频播放器位置。将来把 YouTube / Vimeo / 本地 MP4 链接接入即可。",
  "application.title":"入学申请","application.hint":"在线申请为快速通道；完整版申请表（含学历、家庭状况等）可在资源中心下载 Word 文档填写。","application.pleaseSelect":"请选择",
  "application.fields.nameZh":"中文姓名","application.fields.nameEn":"英文姓名","application.fields.gender":"性别","application.fields.birth":"出生年月","application.fields.nationality":"国籍","application.fields.language":"主要使用语言","application.fields.phone":"手机","application.fields.email":"Email / QQ / 微信","application.fields.city":"目前所在城市 / 国家",
  "application.fields.church":"目前参与的教会","application.fields.churchType":"教会类型","application.fields.conversion":"初信日期（约）","application.fields.baptism":"受洗日期（约）","application.fields.role":"目前服事 / 角色","application.fields.referrer":"介绍人及联系电话",
  "application.fields.program":"申请修读项目","application.fields.eduLevel":"最高学历","application.fields.eduSchool":"毕业学校（选填）","application.edu.secondary":"高中及以下","application.edu.college":"大专","application.edu.bachelor":"本科","application.edu.master":"硕士及以上","application.fields.mode":"偏好的学习方式","application.fields.gifts":"恩赐（选填）","application.fields.motivation":"异象与蒙召 / 信仰见证",
  "application.genders.male":"男","application.genders.female":"女",
  "application.languages.mandarin":"普通话","application.languages.cantonese":"广东话","application.languages.other":"其他",
  "application.churchTypes.tspm":"三自教会","application.churchTypes.house":"家庭教会","application.churchTypes.other":"其他",
  "application.programs.bth":"神学学士 B.Th（2026 届招生）","application.programs.dip":"大学文凭课程 DIP","application.programs.gdip":"研究生文凭 G.DIP","application.programs.mdiv":"道学硕士 M.DIV","application.programs.dmin":"教牧学 / 宣教学博士 D.MIN / D.MISS","application.programs.pastor":"牧会者进修","application.programs.preaching":"讲道学校","application.programs.missionary":"宣教士训练",
  "application.modes.online":"线上为主","application.modes.onsite":"线下为主","application.modes.hybrid":"线上 + 线下",
  "application.consent":"我确认以上资料真实，并愿意接受学校后续联系与入学说明。","application.back":"上一步","application.next":"下一步","application.submit":"提交申请",
  "application.okDemo":"申请已保存在本机演示数据中。正式上线时需要接入后端/数据库。","application.ok":"申请已送出，招生同工会尽快与你联络。","application.error":"提交失败：网络或服务器异常。请稍后重试，或用下方联系方式联络我们。",
  "application.stepOf":"第 {n} 步，共 4 步",
  "review.fullName":"中文姓名","review.englishName":"英文姓名","review.gender":"性别","review.birth":"出生年月","review.nationality":"国籍","review.language":"使用语言","review.phone":"手机","review.email":"Email / QQ / 微信","review.location":"城市 / 国家","review.church":"教会","review.churchType":"教会类型","review.conversionDate":"初信日期","review.baptismDate":"受洗日期","review.role":"服事 / 角色","review.referrer":"介绍人","review.program":"申请项目","review.eduLevel":"最高学历","review.eduSchool":"毕业学校","review.mode":"学习方式","review.gifts":"恩赐","review.motivation":"异象与见证"
 },
 en: {
  "chat.open":"Open live chat","chat.title":"Admissions Assistant","chat.subtitle":"Instant answers · leave a message","chat.placeholder":"Type a question…","chat.send":"Send","chat.note":"Auto-replies are based on this site; messages are forwarded to the admissions team.",
  "chat.greeting":"Peace! I am the AMAS admissions assistant. Ask me about applications, tuition or courses — or leave a message for the admissions team. How can I help?","chat.fallback":"I do not have a confident answer for that. Leave a message and the admissions team will get back to you.",
  "chat.chips.apply":"How do I apply?","chat.chips.tuition":"Tuition fees?","chat.chips.courses":"What courses?","chat.chips.mode":"How are classes held?","chat.chips.leave":"Leave a message",
  "chat.kb.apply":"Click Apply and complete the online form (about 3 minutes). The admissions team will contact you with next steps. A full Word application form is also available in Resources.",
  "chat.kb.tuition":"Tuition is charged per course, paid course by course. For specific amounts, please contact our admissions team directly. Students facing financial hardship may ask about fee reduction, instalments or other learning support.","chat.kb.tuitionBtn":"Tuition & support",
  "chat.kb.courses":"The curriculum centers on Bible, theology, ministry practice and spiritual formation — 10 courses are listed, including Acts & Mission and 1 Corinthians.","chat.kb.coursesBtn":"Browse courses",
  "chat.kb.programs":"Eight programs from Diploma (DIP) to doctoral level (D.Min / D.Miss); the B.Th Class of 2026 intake opens September 2026.","chat.kb.programsBtn":"View programs",
  "chat.kb.mode":"Flexible online + in-person study: online coursework combined with in-person discipleship in Chiang Mai. The B.Th Class of 2026 intake starts 1 September 2026.",
  "chat.kb.contact":"You can reach us via:","chat.kb.contactEmpty":"Contact details will be published soon. You can leave a message right here, or use the inquiry form at the bottom of the page.",
  "chat.kb.location":"The teaching center is in Chiang Mai, Thailand, with online study available.",
  "chat.kb.video":"We have an introduction video you can watch.",
  "chat.leave.askName":"Happy to pass that on. What is your name?","chat.leave.askContact":"Please leave your contact (WeChat / email / phone):","chat.leave.askContent":"What would you like to tell the admissions team?",
  "chat.leave.done":"Message sent — the admissions team will reply soon. Anything else?","chat.leave.doneDemo":"Message saved (demo mode; it will reach the admissions team once the site goes live). Anything else?","chat.leave.fail":"Sorry, sending failed. Please try again later or use the inquiry form at the bottom of the page.",
  "brand.sub":"CHIANG MAI TEACHING CENTER","brand.center":"Teaching Center","brand.zoom":"View the school seal","brand.sealSub":"Asia Missionary Association Seminary · Thailand",
  "announce.brand":"AMAS · Chiang Mai Teaching Center","announce.hot":"2026 B.Th Admissions","announce.link":"Admissions Info →",
  "nav.home":"Home","nav.about":"About","nav.courses":"Courses","nav.admissions":"Admissions","nav.tuition":"Tuition","nav.life":"Student Life","nav.resources":"Resources","nav.contact":"Contact",
  "actions.apply":"Apply","actions.login":"Log In","actions.learn":"Learn More","actions.video":"Watch Introduction","actions.applyNow":"Apply Now","actions.download":"Download ↓","actions.view":"View →","actions.fill":"Fill in →","actions.skip":"Skip to main content","actions.backToTop":"↑ TOP","actions.close":"Close","actions.sending":"Sending…",
  "a11y.themeToNight":"Switch to night mode","a11y.themeToDay":"Switch to day mode","a11y.themeNight":"Night mode","a11y.themeDay":"Day mode","a11y.langSwitch":"Switch language (currently English)","a11y.openMenu":"Open menu","a11y.closeMenu":"Close menu",
  "toast.themeNight":"Night mode on","toast.themeDay":"Day mode on","toast.applied":"Application sent","toast.appliedDemo":"Application submitted (demo)","toast.inquiry":"Inquiry sent","toast.inquiryDemo":"Inquiry submitted (demo)","toast.failed":"Submission failed, please try again","toast.downloaded":"Placeholder file downloaded",
  "meta.credits":"{n} Credits","meta.weeks":"{n} Weeks",
  "hero.title":"Asia Missionary Association Seminary","hero.sub":"亚洲宣教神学院 · CHIANG MAI, THAILAND","hero.verse":"Go therefore and make disciples of all nations.","hero.verseRef":"— Matthew 28:19",
  "herometa.program":"Program","herometa.programVal":"B.Th — Bachelor of Theology","herometa.start":"Class of 2026 starts","herometa.mode":"Format","herometa.modeVal":"Online + On-site",
  "accred.more":"View accreditation →","accred.title":"Academic Accreditation","accred.intro":"The following degree programs of AMAS have been accredited by the Asia Theological Association (ATA).","accred.bthName":"Bachelor of Theology (B.Th.)","accred.mdivName":"Master of Divinity (M.Div.)","accred.dminName":"Doctor of Ministry (D.Min.)","accred.bthNote":"Accredited by the Asia Theological Association (ATA)","accred.note":"ATA accreditation applies to the degree programs listed above; the scope and validity of accreditation are as stated in the official ATA accreditation documents.",
  "actions.consult":"Admissions Inquiry","actions.applyBth":"Apply for B.Th",
  "band.status":"Official student status registered by the main campus","band.mode":"Online courses + on-site training in Chiang Mai","band.adm":"B.Th Class of 2026 intake",
  "admissions.facts.startLabel":"Starts","admissions.facts.startValue":"September 1, 2026","admissions.facts.feeLabel":"Fee","admissions.facts.feeValue":"Please ask our admissions team","admissions.facts.modeLabel":"Mode","admissions.facts.modeValue":"Online + On-site","admissions.facts.statusLabel":"Student status","admissions.facts.statusValue":"Registered by the main campus",
  "admissions.consultBtn":"Quick inquiry — 30 sec","admissions.applyBtn":"Formal application",
  "admissions.path.title1":"New to AMAS?","admissions.path.title2":"Start with a simple conversation.","admissions.path.s1":"Quick inquiry","admissions.path.s1d":"Name + contact + city + what you'd like to know","admissions.path.s2":"Talk with admissions","admissions.path.s2d":"Confirm courses, student status, schedule and fit","admissions.path.s3":"Formal application","admissions.path.s3d":"Then complete the full faith and ministry form",
  "about.title":"AMAS Chiang Mai<br>Rooted in Scripture · Facing the World","about.body":"We provide Scripture-rooted, practice-oriented theological education that forms knowledge, character and ministry skills for faithful service in church, work and mission.","about.link":"Discover our vision and mission",
  "pillars.bible.title":"Biblical Foundation","pillars.bible.body":"Deep confidence in Scripture, careful interpretation and sound theological thinking.",
  "pillars.practice.title":"Practice Oriented","pillars.practice.body":"Connecting classroom learning with ministry, service and real-world questions.",
  "pillars.mission.title":"Mission Vision","pillars.mission.body":"A global, cross-cultural perspective shaped by the Great Commission.",
  "pillars.life.title":"Life Formation","pillars.life.body":"Spiritual life, character and faithful habits formed in community.",
  "stats.courses":"Courses & electives","stats.flex.title":"Flexible Learning","stats.flex.body":"Online + in-person","stats.global.title":"Global Vision","stats.global.body":"Cross-cultural mission network","stats.team.title":"Pastoral Faculty","stats.team.body":"Mentors and teachers","stats.year":"B.Th Class of 2026 intake",
  "mission.aria":"Vision and mission","mission.title":"Education is not just completed.<br>It becomes faithful service.","mission.desc":"We place theology back into church, family, workplace and mission so knowledge, formation and action stay connected.",
  "mission.vision.0":"Raise pastors and missionaries equipped through the Word of God and the power of the Holy Spirit.","mission.vision.1":"Establish mission centers across Asian nations, equipped through the Word and the Spirit.","mission.vision.2":"Establish Bible-centered, practice-oriented seminaries in Asian nations, raising local pastors and workers.",
  "mission.items.0.title":"Rooted in Truth","mission.items.0.body":"Build reliable biblical interpretation and theological foundations.","mission.items.1.title":"Formed in Life","mission.items.1.body":"Grow through spiritual disciplines, community and character.","mission.items.2.title":"Trained in Practice","mission.items.2.body":"Translate learning into preaching, pastoral care and discipleship.","mission.items.3.title":"Sent in Mission","mission.items.3.body":"Share the gospel courageously and serve across cultures.",
  "courses.title":"Curriculum","courses.desc":"A B.Th pathway integrating Bible, theology, ministry practice and spiritual formation.","courses.filterGroup":"Filter courses","courses.filters.all":"All","courses.filters.bible":"Bible","courses.filters.theology":"Theology","courses.filters.ministry":"Ministry","courses.filters.mission":"Mission","courses.filters.formation":"Formation","courses.count":"{n} courses shown","courses.more":"Show all courses ({n} more)","courses.less":"Show fewer courses",
  "courseCards.0.title":"Bible Survey","courseCards.0.body":"A panoramic overview of the structure, storyline and redemptive thread of Scripture.","courseCards.1.title":"Gospel of Matthew","courseCards.1.body":"Study the message of the Kingdom, Christ the King and the way of discipleship.","courseCards.2.title":"Gospel of John","courseCards.2.body":"Know who Jesus is and receive life by believing in His name.","courseCards.3.title":"Acts","courseCards.3.body":"Follow the early church as the gospel spreads from Jerusalem to the ends of the earth.","courseCards.4.title":"Romans","courseCards.4.body":"A systematic study of justification by faith and life in the Spirit.","courseCards.5.title":"1 Corinthians","courseCards.5.body":"Church order, the theology of the cross and community building.","courseCards.6.title":"2 Corinthians","courseCards.6.body":"God's comfort and power in weakness, and the nature of gospel ministry.","courseCards.7.title":"Ephesians","courseCards.7.body":"The mystery of the church as the body of Christ and the new life in Him.","courseCards.8.title":"Hebrews","courseCards.8.body":"Look to Christ our great High Priest and hold fast the hope we profess.","courseCards.9.title":"Revelation","courseCards.9.body":"Eschatological hope and the victory of the church through apocalyptic literature.",
  "courseCards.10.title":"Systematic Theology","courseCards.10.body":"A doctrinal overview for lay believers and beginning students.","courseCards.11.title":"Contextual Theology","courseCards.11.body":"Thinking and living the faith faithfully within Asian contexts.","courseCards.12.title":"Evangelism","courseCards.12.body":"Master the message, methods and follow-up of sharing the gospel.","courseCards.13.title":"Counseling","courseCards.13.body":"Foundations of listening, counseling and spiritual accompaniment.","courseCards.14.title":"Small Group Ministry","courseCards.14.body":"Build, lead and multiply healthy small groups.","courseCards.15.title":"New Believers Ministry","courseCards.15.body":"Walk with new believers as they take root in faith and church life.","courseCards.16.title":"Church Administration","courseCards.16.body":"Practical church governance, team building and ministry planning.","courseCards.17.title":"Worship & Liturgy","courseCards.17.body":"The biblical meaning of worship and the ordering of the service.","courseCards.18.title":"Inner Healing","courseCards.18.body":"Experience healing of inner wounds in truth and by the Spirit.","courseCards.19.title":"Healing Ministry","courseCards.19.body":"Biblical foundations and practice of prayer for healing.","courseCards.20.title":"Healing through God's Word","courseCards.20.body":"Declare God's Word, intercede and shepherd those who are ill.","courseCards.21.title":"Spiritual Warfare","courseCards.21.body":"Biblical principles of spiritual warfare and the whole armor of God.","courseCards.22.title":"Christian Living","courseCards.22.body":"Practice faith, godliness and witness in everyday life.","courseCards.23.title":"Discipleship Life","courseCards.23.body":"Follow Christ as a disciple with steady rhythms of life.","courseCards.24.title":"Life of Assurance","courseCards.24.body":"Build assurance of salvation and a firm, hopeful foundation of faith.",
  "programs.title":"Programs","programs.desc":"A complete ladder from equipping courses to doctoral study; the B.Th Class of 2026 intake is now open, with other programs following in batches.",
  "programs.degree.title":"Degree Programs","programs.degree.sub":"Progressive academic ladder; student status reviewed by AMAS","programs.equip.title":"Equipping Courses","programs.equip.sub":"Short-term training for serving pastors and lay leaders",
  "programs.items.dip.name":"Diploma (DIP)","programs.items.dip.desc":"Foundational theological equipping before degree study",
  "programs.items.bth.name":"Bachelor of Theology","programs.items.bth.desc":"First intake September 2026 · flexible online + in-person",
  "programs.items.gdip.name":"Graduate Diploma","programs.items.gdip.desc":"Entry into theological research for degree holders",
  "programs.items.mdiv.name":"Master of Divinity","programs.items.mdiv.desc":"Full theological and pastoral equipping for vocational ministry",
  "programs.items.dmin.name":"Doctor of Ministry / Missiology","programs.items.dmin.desc":"D.Min / D.Miss — deepening pastoral and mission research and practice",
  "programs.items.pastor.badge":"CE","programs.items.pastor.name":"Pastoral Continuing Education","programs.items.pastor.desc":"Ongoing equipping and renewal for serving pastors",
  "programs.items.preaching.badge":"PR","programs.items.preaching.name":"School of Preaching","programs.items.preaching.desc":"Intensive training from exegesis to proclamation",
  "programs.items.missionary.badge":"MI","programs.items.missionary.name":"Missionary Training","programs.items.missionary.desc":"Discerning the call and preparing for cross-cultural sending",
  "programs.note":"For intake schedules, duration and entry requirements of each program, apply online or contact the admissions team.",
  "nav.programs":"Programs",
  "digital.title":"Digital Campus","digital.desc":"The seminary is building its own learning platform, connecting courses, resources and community in one place.",
  "digital.items.0.title":"Remote Classroom","digital.items.0.body":"Current courses, live lectures and replays gathered into one entry point for continuous mobile learning.",
  "digital.items.1.title":"Library Resources","digital.items.1.body":"Notes, audio and research materials appear in both the library and course pages.",
  "digital.items.2.title":"Alumni Community","digital.items.2.body":"Discussion, intercession, mentor feedback and voice rooms connect learning with community life.",
  "digital.note.label":"In development: ","digital.note.body":"The learning app is in internal testing; a download link will appear here at launch.",
  "meta.lessons":"{n} Lessons",
  "admissions.title":"B.Th Class of 2026 Admissions","admissions.desc":"A flexible, practice-oriented theological pathway for learners committed to growth and service.","admissions.points.0":"Flexible online + in-person study","admissions.points.1":"Tuition available on inquiry","admissions.points.2":"Starts September 2026","admissions.points.3":"Official student status reviewed by AMAS","admissions.card.mode":"Study Mode","admissions.card.modeValue":"Online / In-person","admissions.card.start":"Start Date","admissions.card.location":"Teaching Center","admissions.card.locationValue":"Chiang Mai","admissions.card.language":"Primary Language","admissions.card.languageValue":"Chinese",
  "tuition.title":"Tuition & Learning Support","tuition.motto":"May everyone who is willing to be equipped find a way to keep learning.","tuition.mode":"Course by Course · Pay per Course",
  "tuition.p1":"AMAS charges per course, paid course by course. Students take courses at their own pace without bearing a whole semester's or year's fees at once — keeping study flexible and easing upfront financial pressure. For specific course fees, please contact our admissions team directly.",
  "tuition.p2":"We believe theological formation calls for real commitment from students, while the school, faculty and ministry team share the cost of teaching. Paying course fees faithfully is both a commitment to learning and a support to the teaching ministry.",
  "tuition.v1":"“For if the willingness is there, the gift is acceptable according to what one has, not according to what one does not have.”","tuition.v1ref":"— 2 Corinthians 8:12",
  "tuition.p3":"Therefore, financial difficulty should never keep anyone from theological formation. Students facing genuine hardship who are committed to serious study may speak with our admissions or academic staff. The school will review each situation individually and offer appropriate fee reduction, instalment plans or other learning support.",
  "tuition.p4":"Our principle is not simply to “lower tuition”, but to help everyone who truly wants to learn find a path to continue being equipped.",
  "tuition.v2":"“The one who is taught the word must share all good things with the one who teaches.”","tuition.v2ref":"— Galatians 6:6",
  "tuition.p5":"AMAS hopes to build a healthy learning culture: those who are able pay tuition faithfully; those in hardship receive help; and those with abundance may support other students through giving.",
  "tuition.ctaFee":"Course fees","tuition.ctaAid":"Apply for learning support",
  "tuition.pr.title":"Tuition Principles","tuition.pr.0":"Fees are charged per course — please ask admissions for details","tuition.pr.1":"Pay per course — no full-year payment required","tuition.pr.2":"Individual review and learning support available for financial hardship","tuition.pr.3":"No sincere seeker of formation is turned away merely for financial reasons","tuition.pr.4":"Specific reductions, instalments and support are arranged individually with the school",
  "life.title":"Learning never happens alone.","life.desc":"Classes, mentoring, groups, church ministry and everyday life all shape theological education.","life.items.0.title":"Mentoring","life.items.0.body":"Guidance for life, calling and discernment beyond the classroom.","life.items.0.p0":"Regular one-on-one accompaniment and prayer","life.items.0.p1":"Discernment of study direction and calling","life.items.0.p2":"A network of seasoned pastors walking alongside","life.items.1.title":"Group Learning","life.items.1.body":"Discussion, cases and mutual response deepen understanding.","life.items.1.p0":"Fixed study groups watching over one another","life.items.1.p1":"Course discussion, case sharing and response","life.items.1.p2":"Online fellowship across regions","life.items.2.title":"Ministry Practice","life.items.2.body":"Take learning into church, family, workplace and mission.","life.items.2.p0":"Serving roles alongside local churches","life.items.2.p1":"Practice in preaching, discipleship and visitation","life.items.2.p2":"On-site intensives and practicum weeks in Chiang Mai","life.items.3.title":"Worship & Devotion","life.items.3.body":"Rooted in worship and prayer — life before ministry.","life.items.3.p0":"Steady rhythms of devotion and prayer","life.items.3.p1":"Participation in worship and service","life.items.3.p2":"Godliness and character formed in community",
  "life.rhythm.title":"Weekly Rhythm","life.rhythm.0":"Online courses and reading","life.rhythm.1":"Group discussion and response","life.rhythm.2":"Discipleship and mentoring time","life.rhythm.3":"Church ministry and everyday practice",
  "resources.title":"Resources","resources.searchLabel":"Search resources","resources.searchPlaceholder":"Search resources…","resources.count":"{n} resources found","resources.items.0":"New Student Handbook","resources.items.1":"B.Th Curriculum Guide","resources.items.2":"Tuition & Learning Support","resources.items.3":"Online Application (Fast Track)","resources.items.4":"Application Form (Full Word Version)","resources.items.5":"Upload Your Completed Application","actions.upload":"Upload ↑","upload.name":"Name","upload.contact":"Contact (Email / WeChat / Phone)","upload.file":"Choose your completed form (Word or PDF)","upload.submit":"Upload & Submit","upload.note":"Your file goes directly to the admissions team's inbox; a confirmation page opens after submission.",
  "faq.title":"Frequently Asked Questions","faq.items.0.q":"Can I apply without prior theological study?","faq.items.0.a":"Yes. We value willingness to learn, consistency and commitment to serious formation.","faq.items.1.q":"Are all classes online?","faq.items.1.a":"Learning is flexible: online coursework is combined with encouraged in-person discipleship, practice and community in Chiang Mai.","faq.items.2.q":"Who manages student status and degree completion?","faq.items.2.a":"Official student status is reviewed and established through AMAS according to school policies.","faq.items.3.q":"How do I begin?","faq.items.3.a":"Click Apply, submit basic information and your motivation, then admissions will contact you with next steps.",
  "faq.ask.title":"Still have questions?","faq.ask.desc":"Our AI assistant is available anytime — or leave a message for the admissions team and we will reply soon.","faq.ask.ai":"Ask the AI assistant","faq.ask.leave":"Leave a message",
  "contact.title":"Want to know more?","contact.desc":"Leave your question and preferred contact information, and our team will follow up.","contact.locationLabel":"Location","contact.studyLabel":"Study","contact.studyValue":"Online + In-person","contact.emailLabel":"Email","contact.phoneLabel":"Phone (Thailand)","contact.phoneCNLabel":"Phone (China)","contact.lineLabel":"Line","contact.wechatLabel":"WeChat",
  "form.name":"Name","form.contact":"Email / Line / WeChat","form.message":"Your question","form.send":"Send Inquiry",
  "form.okDemo":"Received. This demo stores the inquiry in your browser.","form.ok":"Received. We will follow up using the contact details you provided.","form.error":"Submission failed: network or server error. Please try again later or contact us directly.",
  "video.title":"Seminary Introduction","video.placeholder":"The video player is ready. Connect a YouTube, Vimeo, or local MP4 URL when available.",
  "application.title":"Admission Application","application.hint":"The online form is a fast track; the full application (education history, family details, etc.) is available in Resources as a Word download.","application.pleaseSelect":"Please select",
  "application.fields.nameZh":"Name (Chinese)","application.fields.nameEn":"Name (English)","application.fields.gender":"Gender","application.fields.birth":"Date of Birth","application.fields.nationality":"Nationality","application.fields.language":"Primary Language","application.fields.phone":"Mobile","application.fields.email":"Email / QQ / WeChat","application.fields.city":"Current City / Country",
  "application.fields.church":"Current Church","application.fields.churchType":"Church Type","application.fields.conversion":"Conversion Date (approx.)","application.fields.baptism":"Baptism Date (approx.)","application.fields.role":"Current Ministry / Role","application.fields.referrer":"Referrer & Phone",
  "application.fields.program":"Program Applying For","application.fields.eduLevel":"Highest Education","application.fields.eduSchool":"School Graduated (optional)","application.edu.secondary":"High school or below","application.edu.college":"Associate / College","application.edu.bachelor":"Bachelor's degree","application.edu.master":"Master's or above","application.fields.mode":"Preferred Study Mode","application.fields.gifts":"Spiritual Gifts (optional)","application.fields.motivation":"Vision, Calling & Testimony",
  "application.genders.male":"Male","application.genders.female":"Female",
  "application.languages.mandarin":"Mandarin","application.languages.cantonese":"Cantonese","application.languages.other":"Other",
  "application.churchTypes.tspm":"TSPM church","application.churchTypes.house":"House church","application.churchTypes.other":"Other",
  "application.programs.bth":"Bachelor of Theology B.Th (2026 first intake)","application.programs.dip":"Diploma DIP","application.programs.gdip":"Graduate Diploma G.DIP","application.programs.mdiv":"Master of Divinity M.DIV","application.programs.dmin":"Doctor of Ministry / Missiology D.MIN / D.MISS","application.programs.pastor":"Pastoral Continuing Education","application.programs.preaching":"School of Preaching","application.programs.missionary":"Missionary Training",
  "application.modes.online":"Mainly online","application.modes.onsite":"Mainly in-person","application.modes.hybrid":"Online + in-person",
  "application.consent":"I confirm the information above is accurate and agree to be contacted regarding admissions.","application.back":"Back","application.next":"Next","application.submit":"Submit Application",
  "application.okDemo":"Application saved locally for demo. Connect a backend/database for production.","application.ok":"Application sent. Our admissions team will contact you soon.","application.error":"Submission failed: network or server error. Please retry, or reach us with the contact details below.",
  "application.stepOf":"Step {n} of 4",
  "review.fullName":"Name (Chinese)","review.englishName":"Name (English)","review.gender":"Gender","review.birth":"Date of Birth","review.nationality":"Nationality","review.language":"Language","review.phone":"Mobile","review.email":"Email / QQ / WeChat","review.location":"City / Country","review.church":"Church","review.churchType":"Church Type","review.conversionDate":"Conversion","review.baptismDate":"Baptism","review.role":"Ministry / Role","review.referrer":"Referrer","review.program":"Program","review.eduLevel":"Highest Education","review.eduSchool":"School","review.mode":"Study Mode","review.gifts":"Gifts","review.motivation":"Vision & Testimony"
 }
};

let currentLang = "zh";
try{ currentLang = localStorage.getItem("amas-lang") || "zh"; }catch(e){}
if(!i18n[currentLang]) currentLang = "zh";

// 取词条；缺失时回退中文，再回退键名本身，方便发现漏翻
function t(key, vars){
  let s = i18n[currentLang]?.[key] ?? i18n.zh[key] ?? key;
  if(vars) for(const k in vars) s = s.replaceAll("{"+k+"}", vars[k]);
  return s;
}

function applyLanguage(lang){
  currentLang = i18n[lang] ? lang : "zh";
  try{ localStorage.setItem("amas-lang", currentLang); }catch(e){}
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";

  $$("[data-i18n]").forEach(el => {
    const val = i18n[currentLang][el.dataset.i18n];
    if(val === undefined) return;
    const text = el.dataset.i18nN !== undefined ? val.replaceAll("{n}", el.dataset.i18nN) : val;
    // 只有确实含标记（如 <br>）的词条才走 innerHTML
    if(text.includes("<")) el.innerHTML = text; else el.textContent = text;
  });
  $$("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  $$("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));

  $("#langBtn").setAttribute("aria-label", t("a11y.langSwitch"));
  applyTheme(currentTheme, { persist:false });          // 刷新主题按钮的 aria/title 文案
  refreshStepsLabel();
  renderContactMeta();
  if(appModal?.classList.contains("open") && appStep === 3) buildReview();
  announceCourseCount();
  announceResourceCount();
}
$("#langBtn").addEventListener("click", () => applyLanguage(currentLang === "zh" ? "en" : "zh"));


/* ===== 遮罩层通用逻辑：焦点陷阱 + 焦点归还 ===== */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
const openLayers = [];   // 栈顶即当前生效的遮罩

function openLayer(root, panel, onClose){
  const layer = { root, panel, onClose, restoreTo: document.activeElement };
  openLayers.push(layer);
  root.classList.add("open");
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  // 焦点移入面板：优先第一个可聚焦元素，否则给面板本身临时 tabindex
  const first = $$(FOCUSABLE, panel).find(el => el.offsetParent !== null);
  if(first) first.focus();
  else { panel.setAttribute("tabindex","-1"); panel.focus(); }
  return layer;
}
function closeLayer(root, { restore = true } = {}){
  const idx = openLayers.findIndex(l => l.root === root);
  if(idx === -1) return;
  const [layer] = openLayers.splice(idx, 1);
  root.classList.remove("open");
  root.setAttribute("aria-hidden", "true");
  if(!openLayers.length) document.body.classList.remove("modal-open");
  layer.onClose?.();
  if(restore) layer.restoreTo?.focus?.();
}
document.addEventListener("keydown", e => {
  const layer = openLayers[openLayers.length - 1];
  if(!layer) return;
  if(e.key === "Escape"){ e.preventDefault(); closeLayer(layer.root); return; }
  if(e.key !== "Tab") return;
  const items = $$(FOCUSABLE, layer.panel).filter(el => el.offsetParent !== null);
  if(!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
});


/* ===== 校标灯箱 ===== */
const sealModal = $("#sealModal");
$$("[data-open-seal]").forEach(x => x.addEventListener("click", () =>
  openLayer(sealModal, $(".seal-card", sealModal))
));
$$("[data-close-seal]").forEach(x => x.addEventListener("click", () => closeLayer(sealModal)));

/* ===== 移动端抽屉 ===== */
const drawer = $("#mobileDrawer"), menuBtn = $("#menuBtn");
function openDrawer(){
  openLayer(drawer, $(".drawer-panel", drawer), () => menuBtn.setAttribute("aria-expanded","false"));
  menuBtn.setAttribute("aria-expanded","true");
}
function closeDrawer(opts){ closeLayer(drawer, opts); }
menuBtn.addEventListener("click", openDrawer);
$$("[data-close-drawer]").forEach(x => x.addEventListener("click", () =>
  // 点导航链接关闭时不要把焦点抢回汉堡按钮，让锚点跳转自然生效
  closeDrawer({ restore: x.tagName !== "A" })
));


/* ===== 导航高亮 =====
   学费 / 见证在桌面导航里没有独立入口，归到最接近的父级条目下高亮 */
const NAV_ALIAS = { tuition:"admissions", mission:"about", programs:"courses", digital:"life" };
const sections = $$("main section[id]");
const navLinks = $$(".desktop-nav a");
const navObs = new IntersectionObserver(entries => {
  const visible = entries.filter(e => e.isIntersecting)
                         .sort((a,b) => b.intersectionRatio - a.intersectionRatio)[0];
  if(!visible) return;
  const id = NAV_ALIAS[visible.target.id] || visible.target.id;
  navLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + id));
}, { rootMargin:"-35% 0px -55% 0px", threshold:[0,.2,.5] });
sections.forEach(s => navObs.observe(s));

/* ===== 滚动显现 =====
   html.js-reveal 由 <head> 里的脚本按能力/动效偏好决定是否加；
   没加就说明元素本来就是可见的，这里不必再观察 */
if(document.documentElement.classList.contains("js-reveal")){
  const revObs = new IntersectionObserver(entries => entries.forEach(e => {
    if(e.isIntersecting){ e.target.classList.add("visible"); revObs.unobserve(e.target); }
  }), { threshold:.12 });
  $$(".reveal").forEach(el => revObs.observe(el));
}

/* ===== 滚动按钮 ===== */
$$("[data-scroll]").forEach(b => b.addEventListener("click", () =>
  $(b.dataset.scroll)?.scrollIntoView({ behavior:"smooth" })
));
$("#backToTop").addEventListener("click", () => window.scrollTo({ top:0, behavior:"smooth" }));

/* ===== 课程筛选 + 折叠展开 ===== */
const COURSE_LIMIT = 6;
let coursesExpanded = false;
function announceCourseCount(){
  const n = $$(".course-card:not(.hidden-card)").length;
  $("#courseCount").textContent = t("courses.count", { n });
}
function applyCourseVisibility(){
  const f = $(".filter.active")?.dataset.filter || "all";
  let shown = 0, total = 0;
  $$(".course-card").forEach(card => {
    const match = f === "all" || card.dataset.category === f;
    if(match) total++;
    const visible = match && (coursesExpanded || shown < COURSE_LIMIT);
    if(visible) shown++;
    card.classList.toggle("hidden-card", !visible);
  });
  const btn = $("#courseMoreBtn");
  if(btn){
    btn.hidden = total <= COURSE_LIMIT;
    $("span", btn).textContent = coursesExpanded
      ? t("courses.less")
      : t("courses.more", { n: total - COURSE_LIMIT });
  }
  announceCourseCount();
}
$$(".filter").forEach(btn => btn.addEventListener("click", () => {
  $$(".filter").forEach(x => { x.classList.remove("active"); x.setAttribute("aria-pressed","false"); });
  btn.classList.add("active"); btn.setAttribute("aria-pressed","true");
  coursesExpanded = false;
  applyCourseVisibility();
}));
$("#courseMoreBtn")?.addEventListener("click", () => {
  coursesExpanded = !coursesExpanded;
  applyCourseVisibility();
  if(!coursesExpanded) $("#courses")?.scrollIntoView({ behavior: "smooth" });
});
applyCourseVisibility();
$("#langBtn")?.addEventListener("click", () => setTimeout(applyCourseVisibility, 0));

/* ===== 资源搜索 ===== */
function announceResourceCount(){
  const n = $$(".resource-row:not(.resource-hidden)").length;
  $("#resourceCount").textContent = t("resources.count", { n });
}
$("#resourceSearch").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  $$(".resource-row").forEach(r => r.classList.toggle("resource-hidden",
    !!q && !r.dataset.search.toLowerCase().includes(q) && !r.textContent.toLowerCase().includes(q)
  ));
  announceResourceCount();
});

/* ===== Toast ===== */
let toastTimer;
function toast(msg){
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

/* ===== 占位资源下载 =====
   正式上线请把这里换成真实 PDF 的链接（或 <a href="...pdf" download>）。 */
const downloadable = {
  "student-handbook": { title:"AMAS 亚洲宣教神学院｜新生入学手册", content:"这是网站前端演示生成的占位文档。正式上线前请替换为学校官方 PDF 文件。" },
  "curriculum":       { title:"AMAS 亚洲宣教神学院｜B.Th 课程目录", content:"这是网站前端演示生成的占位文档。正式上线前请替换为学校正式课程目录 PDF。" }
};
$$("[data-download]").forEach(btn => btn.addEventListener("click", () => {
  const key = btn.dataset.download;
  const real = CONFIG.resources?.[key];
  if(real){                                        // 配了真实文件就直接下载它
    const a = document.createElement("a");
    a.href = real;
    a.download = "";
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
    return;
  }
  const d = downloadable[key];
  if(!d) return;
  const blob = new Blob([d.title + "\n\n" + d.content], { type:"text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = key + ".txt";
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t("toast.downloaded"));
}));

/* ===== 介绍视频弹窗 ===== */
const videoModal = $("#videoModal");
function mountVideo(){
  if(!CONFIG.videoUrl) return;                       // 没配地址就保留占位说明
  const holder = $(".video-placeholder", videoModal);
  if(holder.dataset.mounted) return;
  const isFile = /\.(mp4|webm|ogg)(\?|$)/i.test(CONFIG.videoUrl);
  holder.innerHTML = isFile
    ? `<video src="${escapeHTML(CONFIG.videoUrl)}" controls playsinline style="width:100%;height:auto;display:block"></video>`
    : `<iframe src="${escapeHTML(CONFIG.videoUrl)}" title="${escapeHTML(t("video.title"))}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;display:block"></iframe>`;
  holder.style.minHeight = "0";
  holder.style.padding = "0";
  holder.dataset.mounted = "1";
}
$("#videoBtn")?.addEventListener("click", () => {
  mountVideo();
  openLayer(videoModal, $(".video-card", videoModal), () => {
    const v = $("video", videoModal); v?.pause();
    const f = $("iframe", videoModal); if(f) f.src = f.src;   // 停止 iframe 播放
  });
});
$$("[data-close-video]").forEach(x => x.addEventListener("click", () => closeLayer(videoModal)));


/* ===== 提交到后端（未配置 endpoint 时回退到本地演示）===== */
async function sendPayload(kind, payload){
  if(!CONFIG.formEndpoint){
    const key = kind === "application" ? "amas-applications"
              : kind === "chat"        ? "amas-chat-messages"
              : "amas-inquiries";
    try{
      const all = JSON.parse(localStorage.getItem(key) || "[]");
      all.push(payload);
      localStorage.setItem(key, JSON.stringify(all));
    }catch(e){}
    return { ok:true, demo:true };
  }
  const res = await fetch(CONFIG.formEndpoint, {
    method: "POST",
    headers: CONFIG.formHeaders,
    body: JSON.stringify(payload)
  });
  if(!res.ok) throw new Error("HTTP " + res.status);
  return { ok:true, demo:false };
}

// 提交按钮的忙碌态
function setBusy(btn, busy, labelEl){
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  btn.disabled = busy;
  if(labelEl){
    if(busy){ labelEl.dataset.prev = labelEl.textContent; labelEl.textContent = t("actions.sending"); }
    else if(labelEl.dataset.prev){ labelEl.textContent = labelEl.dataset.prev; delete labelEl.dataset.prev; }
  }
}


/* ===== 申请弹窗（四步向导，字段对应学院纸质申请表）===== */
const APP_STEPS = 4;
const appModal = $("#applicationModal"), appForm = $("#applicationForm");
let appStep = 1;

function openApplication(){
  showAppStep(1);
  openLayer(appModal, $(".application-card", appModal));
}
function closeApplication(){ closeLayer(appModal); }
$$("[data-open-application]").forEach(x => x.addEventListener("click", openApplication));
$$("[data-close-application]").forEach(x => x.addEventListener("click", closeApplication));

function stepValid(step){
  const sec = $(`.app-step[data-step="${step}"]`);
  let ok = true;
  $$("input,textarea,select", sec).forEach(f => {
    if(f.closest(".honeypot")) return;
    if(!f.checkValidity()){ if(ok) f.reportValidity(); ok = false; }
  });
  return ok;
}
function refreshStepsLabel(){
  $(".steps")?.setAttribute("aria-label", t("application.stepOf", { n: appStep }));
}
function showAppStep(step){
  appStep = step;
  refreshStepsLabel();
  $$(".app-step").forEach(s => s.classList.toggle("active", Number(s.dataset.step) === step));
  $$("[data-step-indicator]").forEach(s => {
    const on = Number(s.dataset.stepIndicator) <= step;
    s.classList.toggle("active", on);
    s.setAttribute("aria-current", Number(s.dataset.stepIndicator) === step ? "step" : "false");
  });
  $("#prevStep").disabled = step === 1;
  $("#nextStep").classList.toggle("hidden", step === APP_STEPS);
  $("#submitApplication").classList.toggle("hidden", step !== APP_STEPS);
  $("#applicationStatus").textContent = "";
  $("#applicationStatus").removeAttribute("data-state");
  if(step === APP_STEPS) buildReview();
}
// 复核页：值为枚举的字段翻译成当前语言的文字
const REVIEW_ENUMS = { gender:"genders", language:"languages", churchType:"churchTypes", program:"programs", mode:"modes", eduLevel:"edu" };
function buildReview(){
  const fd = new FormData(appForm);
  const keys = ["fullName","englishName","gender","birth","nationality","language","phone","email","location",
                "church","churchType","conversionDate","baptismDate","role","referrer",
                "program","eduLevel","eduSchool","mode","gifts","motivation"];
  $("#applicationReview").innerHTML = "<dl>" + keys.map(k => {
    let v = fd.get(k) || "—";
    if(v !== "—" && REVIEW_ENUMS[k]) v = t("application." + REVIEW_ENUMS[k] + "." + v);
    return `<dt>${escapeHTML(t("review." + k))}</dt><dd>${escapeHTML(v)}</dd>`;
  }).join("") + "</dl>";
}
$("#nextStep").addEventListener("click", () => { if(stepValid(appStep)) showAppStep(Math.min(APP_STEPS, appStep + 1)); });
$("#prevStep").addEventListener("click", () => showAppStep(Math.max(1, appStep - 1)));

appForm.addEventListener("submit", async e => {
  e.preventDefault();
  for(let s = 1; s < APP_STEPS; s++){
    if(!stepValid(s)){ showAppStep(s); return; }
  }
  if(!stepValid(APP_STEPS)) return;

  const data = Object.fromEntries(new FormData(appForm).entries());
  if(data.website){ closeApplication(); return; }          // 蜜罐被填 = 机器人，静默丢弃
  delete data.website;
  data._form = "admission-application";
  data._subject = "AMAS 入学申请 [" + (data.program || "") + "] — " + (data.fullName || "");
  data.submittedAt = new Date().toISOString();
  data.lang = currentLang;

  const btn = $("#submitApplication"), label = btn.querySelector("span"), status = $("#applicationStatus");
  setBusy(btn, true, label);
  status.removeAttribute("data-state");
  try{
    const r = await sendPayload("application", data);
    status.dataset.state = "ok";
    status.textContent = t(r.demo ? "application.okDemo" : "application.ok");
    toast(t(r.demo ? "toast.appliedDemo" : "toast.applied"));
    setTimeout(() => {
      closeApplication();
      appForm.reset();
      showAppStep(1);
    }, 1800);
  }catch(err){
    status.dataset.state = "error";
    status.textContent = t("application.error");
    toast(t("toast.failed"));
  }finally{
    setBusy(btn, false, label);
  }
});


/* ===== 咨询表单 ===== */
$("#contactForm").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget;
  if(!form.checkValidity()){ form.reportValidity(); return; }

  const data = Object.fromEntries(new FormData(form).entries());
  if(data.website){ form.reset(); return; }                // 蜜罐
  delete data.website;
  data._form = "contact-inquiry";
  data._subject = "AMAS 网站咨询 — " + (data.name || "");
  data.submittedAt = new Date().toISOString();
  data.lang = currentLang;

  const btn = form.querySelector('button[type="submit"]'), label = btn.querySelector("span"), status = $("#contactStatus");
  setBusy(btn, true, label);
  status.removeAttribute("data-state");
  try{
    const r = await sendPayload("contact", data);
    status.dataset.state = "ok";
    status.textContent = t(r.demo ? "form.okDemo" : "form.ok");
    toast(t(r.demo ? "toast.inquiryDemo" : "toast.inquiry"));
    form.reset();
  }catch(err){
    status.dataset.state = "error";
    status.textContent = t("form.error");
    toast(t("toast.failed"));
  }finally{
    setBusy(btn, false, label);
  }
});


/* ===== 联系方式：按 CONFIG.contact 渲染，留空的不出现 ===== */
function renderContactMeta(){
  const meta = $("#contactMeta");
  $$("[data-contact-row]", meta).forEach(el => el.remove());
  const rows = [
    ["email",  "contact.emailLabel",  v => `<a href="mailto:${encodeURI(v)}">${escapeHTML(v)}</a>`],
    ["phone",  "contact.phoneLabel",  v => `<a href="tel:${encodeURI(v.replace(/\s/g,""))}">${escapeHTML(v)}</a>`],
    ["phoneCN","contact.phoneCNLabel",v => `<a href="tel:${encodeURI(v.replace(/\s/g,""))}">${escapeHTML(v)}</a>`],
    ["line",   "contact.lineLabel",   v => escapeHTML(v)],
    ["wechat", "contact.wechatLabel", v => escapeHTML(v)]
  ];
  for(const [key, label, fmt] of rows){
    const v = CONFIG.contact?.[key];
    if(!v) continue;
    const div = document.createElement("div");
    div.setAttribute("data-contact-row", key);
    div.innerHTML = `<span>${escapeHTML(t(label))}</span><b>${fmt(v)}</b>`;
    meta.appendChild(div);
  }
}

/* ===== 打印：先把所有问答展开，打完还原 ===== */
addEventListener("beforeprint", () => $$(".faq-item").forEach(d => {
  d.dataset.wasOpen = d.open ? "1" : "";
  d.open = true;
}));
addEventListener("afterprint", () => $$(".faq-item").forEach(d => {
  d.open = d.dataset.wasOpen === "1";
}));

/* ===== AI 客服 / 留言助手 =====
   规则应答基于站点信息；CONFIG.ai.endpoint 配置后优先走大模型，失败回退规则。 */
const chatFab = $("#chatFab"), chatPanel = $("#chatPanel"), chatBody = $("#chatBody"),
      chatText = $("#chatText"), chatSend = $("#chatSend");
let chatGreeted = false;
let leaveFlow = null;   // null | {step:1|2|3, name, contact}
const chatHistory = [];

function chatMsg(text, who){
  const d = document.createElement("div");
  d.className = "chat-msg " + who;
  d.textContent = text;
  chatBody.appendChild(d);
  chatBody.scrollTop = chatBody.scrollHeight;
  if(who !== "typing") chatHistory.push({ role: who === "user" ? "user" : "assistant", content: text });
  return d;
}
function chatChips(items){
  const wrap = document.createElement("div");
  wrap.className = "chat-chips";
  items.forEach(it => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = it.label;
    b.addEventListener("click", () => { wrap.remove(); it.fn(); });
    wrap.appendChild(b);
  });
  chatBody.appendChild(wrap);
  chatBody.scrollTop = chatBody.scrollHeight;
}
function chatAction(label, fn){ chatChips([{ label, fn }]); }

function openChat(){
  document.documentElement.classList.add("chat-open");
  chatFab.setAttribute("aria-expanded", "true");
  if(!chatGreeted){ chatGreeted = true; chatGreet(); }
  setTimeout(() => chatText.focus(), 220);
}
function closeChat(){
  document.documentElement.classList.remove("chat-open");
  chatFab.setAttribute("aria-expanded", "false");
}
chatFab.addEventListener("click", () =>
  document.documentElement.classList.contains("chat-open") ? closeChat() : openChat());
$("#faqAskAi")?.addEventListener("click", () => openChat());
$("#faqLeaveMsg")?.addEventListener("click", () => { openChat(); startLeaveFlow(); });
$("#consultBtn")?.addEventListener("click", () => openChat());
$("#uploadToggle")?.addEventListener("click", () => {
  const f = $("#uploadForm");
  f.hidden = !f.hidden;
  $("#uploadToggle").setAttribute("aria-expanded", String(!f.hidden));
  if(!f.hidden) f.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#chatClose").addEventListener("click", closeChat);
document.addEventListener("keydown", e => {
  if(e.key === "Escape" && !openLayers.length &&
     document.documentElement.classList.contains("chat-open")) closeChat();
});

function chatGreet(){
  chatMsg(t("chat.greeting"), "bot");
  chatChips([
    { label: t("chat.chips.apply"),   fn: () => chatAsk(t("chat.chips.apply")) },
    { label: t("chat.chips.tuition"), fn: () => chatAsk(t("chat.chips.tuition")) },
    { label: t("chat.chips.courses"), fn: () => chatAsk(t("chat.chips.courses")) },
    { label: t("chat.chips.mode"),    fn: () => chatAsk(t("chat.chips.mode")) },
    { label: t("chat.chips.leave"),   fn: startLeaveFlow }
  ]);
}

/* 站点知识库：test 对中英输入都生效 */
const CHAT_KB = [
  { test: /申请|报名|报读|apply|admission|enroll/i,
    reply: () => t("chat.kb.apply"),
    action: () => chatAction(t("actions.applyNow"), () => { closeChat(); openApplication(); }) },
  { test: /学费|费用|多少钱|缴费|tuition|fee|cost|price/i,
    reply: () => t("chat.kb.tuition"),
    action: () => chatAction(t("chat.kb.tuitionBtn"), () => { closeChat(); $("#tuition")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /课程|课表|科目|course|curriculum|class(es)?\b/i,
    reply: () => t("chat.kb.courses"),
    action: () => chatAction(t("chat.kb.coursesBtn"), () => { closeChat(); $("#courses")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /学位|学制|项目|文凭|硕士|博士|b\.?th|m\.?div|dip|program|degree/i,
    reply: () => t("chat.kb.programs"),
    action: () => chatAction(t("chat.kb.programsBtn"), () => { closeChat(); $("#programs")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /线上|线下|上课|开学|时间|授课|online|schedule|start|september|mode/i,
    reply: () => t("chat.kb.mode") },
  { test: /联系|微信|电话|邮箱|contact|email|phone|wechat|line\b/i,
    reply: () => {
      const c = CONFIG.contact || {};
      const rows = [c.email, c.phone, c.line && "Line: " + c.line, c.wechat && ("WeChat: " + c.wechat)].filter(Boolean);
      return rows.length ? t("chat.kb.contact") + "\n" + rows.join("\n") : t("chat.kb.contactEmpty");
    } },
  { test: /学籍|毕业|颁发|文凭|学历|认证|graduat|status|accredit/i,
    reply: () => t("faq.items.2.a") },
  { test: /背景|基础|没学过|零基础|background|beginner/i,
    reply: () => t("faq.items.0.a") },
  { test: /地址|在哪|位置|清迈|泰国|where|location|address|chiang\s*mai/i,
    reply: () => t("chat.kb.location") },
  { test: /视频|介绍|了解|video|introduc/i,
    reply: () => t("chat.kb.video"),
    action: () => chatAction(t("actions.video"), () => { closeChat(); mountVideo(); openLayer(videoModal, $(".video-card", videoModal)); }) }
];

function ruleAnswer(q){
  for(const item of CHAT_KB){
    if(item.test.test(q)){
      chatMsg(item.reply(), "bot");
      item.action?.();
      return true;
    }
  }
  return false;
}

/* 留言流程：姓名 → 联系方式 → 内容 → 提交 */
function startLeaveFlow(){
  leaveFlow = { step: 1 };
  chatMsg(t("chat.leave.askName"), "bot");
  chatText.focus();
}
async function advanceLeaveFlow(text){
  if(leaveFlow.step === 1){
    leaveFlow.name = text; leaveFlow.step = 2;
    chatMsg(t("chat.leave.askContact"), "bot");
  } else if(leaveFlow.step === 2){
    leaveFlow.contact = text; leaveFlow.step = 3;
    chatMsg(t("chat.leave.askContent"), "bot");
  } else {
    const data = {
      _form: "chat-message",
      _subject: "AMAS 网站留言 — " + leaveFlow.name,
      name: leaveFlow.name, contact: leaveFlow.contact, message: text,
      submittedAt: new Date().toISOString(), lang: currentLang
    };
    leaveFlow = null;
    const typing = chatMsg("···", "typing bot");
    try{
      const r = await sendPayload("chat", data);
      typing.remove();
      chatMsg(t(r.demo ? "chat.leave.doneDemo" : "chat.leave.done"), "bot");
    }catch(e){
      typing.remove();
      chatMsg(t("chat.leave.fail"), "bot");
    }
  }
}

async function aiAnswer(q){
  const typing = chatMsg("···", "typing bot");
  try{
    const res = await fetch(CONFIG.ai.endpoint, {
      method: "POST", headers: CONFIG.ai.headers,
      body: JSON.stringify({ messages: chatHistory.slice(-12) })
    });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    typing.remove();
    if(j.reply){ chatMsg(String(j.reply), "bot"); return true; }
    throw new Error("no reply");
  }catch(e){
    typing.remove();
    return false;
  }
}

async function chatAsk(text){
  text = text.trim();
  if(!text) return;
  chatMsg(text, "user");
  chatText.value = "";
  if(leaveFlow){ advanceLeaveFlow(text); return; }
  if(CONFIG.ai.endpoint && await aiAnswer(text)) return;
  if(!ruleAnswer(text)){
    chatMsg(t("chat.fallback"), "bot");
    chatChips([{ label: t("chat.chips.leave"), fn: startLeaveFlow }]);
  }
}
chatSend.addEventListener("click", () => chatAsk(chatText.value));
chatText.addEventListener("keydown", e => { if(e.key === "Enter") chatAsk(chatText.value); });

/* ===== 收尾 ===== */
$("#copyrightYear").textContent = Math.max(2026, new Date().getFullYear());
if(window.matchMedia("(min-width:700px)").matches) $(".faq-item")?.setAttribute("open","");
applyLanguage(currentLang);
