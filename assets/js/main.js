/* AMAS 亚洲宣教神学院官网 — 主脚本（四语言词典 + 交互）。词典维护规则见 README */

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
  /* 配套 App（仓库 enoslee0701-dev/AMAS-Seminary）。填入正式地址后，数字校园版块自动出现入口按钮 */
  /* 配套 App。地址保持为空 = 未上线；结构预留 deep link / 来源 / 评估 / 画像参数扩展 */
  app: {
    repo: "https://github.com/enoslee0701-dev/AMAS-Seminary",
    web: "", ios: "", android: "",
    deepLink: "",                       // 例：amas://profile 或 https://app.amasthai.com
    params: { source: "website-discover", assessment: "discover-quick-v1", profile: "" }
  },
  videoUrl: "",

  /* 真实的下载文件地址。留空则沿用演示用的占位 .txt。
     单文件部署时也可以直接塞 data:application/pdf;base64,... （会显著增大文件体积）。 */
  resources: {
    "student-handbook": { zh:"assets/files/AMAS-student-handbook.pdf", en:"assets/files/AMAS-student-handbook-en.pdf", ko:"assets/files/AMAS-student-handbook-ko.pdf", th:"assets/files/AMAS-student-handbook-th.pdf" },
    "curriculum": { zh:"assets/files/AMAS-BTh-curriculum.pdf", en:"assets/files/AMAS-BTh-curriculum-en.pdf", ko:"assets/files/AMAS-BTh-curriculum-ko.pdf", th:"assets/files/AMAS-BTh-curriculum-th.pdf" }
  },

  /* Word 版入学申请表（按语言分发） */
  applicationForm: { zh:"assets/files/AMAS-application-form.docx", en:"assets/files/AMAS-application-form-en.docx", ko:"assets/files/AMAS-application-form-ko.docx", th:"assets/files/AMAS-application-form-th.docx" },

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
  "chat.chips.human":"人工客服","chat.human.intro":"好的，你可以通过以下方式直接联系招生同工（一般当天回复）：","chat.human.wechat":"微信 {id} · 点击复制","chat.human.line":"Line {id} · 点击复制","chat.human.note":"添加好友时请注明「AMAS 咨询」。如果暂时联系不上，也可以在这里留言，同工会主动联系你。",
  "chat.kb.apply":"点击「申请入学」填写在线申请（约 3 分钟），提交后招生同工会主动联系你说明后续步骤；也可以在资源中心下载完整版 Word 申请表。",
  "chat.kb.tuition":"学费采用按科修读、按科缴费的方式，具体金额请亲自向招生同工咨询；经济上有困难的学员可说明情况，申请学费减免、分期或其他学习支持。","chat.kb.tuitionBtn":"查看学费与支持",
  "chat.kb.courses":"按学院官方课程体系开设 52 门课程（含 13 门选修）与属灵训练项目，硕士班 G.Dip / M.Div 毕业 90 学分，涵盖圣经、系统、历史、实践神学与圣经语言。","chat.kb.coursesBtn":"浏览课程",
  "chat.kb.programs":"学位课程采用学分制、按科修读：神学学士（B.Th，90 学分）、教牧学研究硕士（G.Dip，90 学分）、道学硕士（M.Div，90 学分）与教牧学 / 宣教学博士（D.Min / D.Miss，48 学分）；证书与装备课程有平信徒指导者课程、牧会训练课程、牧会者进修、讲道学校与宣教士训练。2026 届 B.Th 招生进行中，9 月开学。","chat.kb.programsBtn":"查看培养项目",
  "chat.kb.mode":"线上 + 线下灵活学习：线上课程为主，鼓励参与清迈线下门训与实践。2026 届 B.Th 于 2026 年 9 月开学。",
  "chat.kb.contact":"可以通过以下方式联系我们：","chat.kb.contactEmpty":"联系方式即将公布；现在可以直接在这里留言，或用页面底部的咨询表单，招生同工会主动联系你。",
  "chat.kb.location":"学院教学中心位于泰国清迈（Chiang Mai, Thailand），同时提供线上学习。",
  "chat.kb.video":"我们准备了学院介绍视频，可以点击观看。",
  "chat.leave.askName":"好的，我来帮你转达。请问怎么称呼你？","chat.leave.askContact":"留下你的联系方式（微信 / 邮箱 / 电话均可）：","chat.leave.askContent":"想对招生同工说什么？请输入留言内容：",
  "chat.leave.done":"留言已送出，招生同工会尽快回复你。还有其他问题吗？","chat.leave.doneDemo":"留言已保存（当前为演示模式，正式上线后将直达招生同工）。还有其他问题吗？","chat.leave.fail":"抱歉，留言发送失败，请稍后再试，或使用页面底部的咨询表单。",
  "brand.sub":"亚洲宣教神学院 · 清迈教学中心","brand.zoom":"查看校标大图","brand.sealSub":"AMAS 亚洲宣教神学院 · 泰国",
  "announce.brand":"AMAS 亚洲宣教神学院 · 清迈教学中心","announce.verse":"“我可以差遣谁呢？谁肯为我们去呢？”“我在这里，请差遣我！”— 以赛亚书 6:8","announce.moto":"装备今日的门徒 · 差遣明日的使者","announce.hot":"2026 届神学学士 B.Th 招生","announce.link":"查看招生信息 →",
  "nav.home":"首页","nav.about":"关于我们","nav.courses":"课程设置","nav.admissions":"招生信息","nav.tuition":"学费与支持","nav.life":"学院生活","nav.resources":"资源中心","nav.contact":"联系我们",
  "actions.apply":"申请入学","actions.login":"登录","actions.video":"观看介绍视频","actions.applyNow":"立即申请","actions.download":"下载 ↓","actions.view":"查看 →","actions.fill":"填写 →","actions.skip":"跳到主要内容","actions.backToTop":"↑ 顶部","actions.close":"关闭","actions.sending":"提交中…",
  "a11y.themeToNight":"切换到夜晚模式","a11y.themeToDay":"切换到白日模式","a11y.themeNight":"夜晚模式","a11y.themeDay":"白日模式","a11y.langSwitch":"切换语言（当前中文）","a11y.openMenu":"打开菜单","a11y.closeMenu":"关闭菜单",
  "toast.themeNight":"已切换为夜晚模式","toast.themeDay":"已切换为白日模式","toast.applied":"申请资料已送出","toast.appliedDemo":"申请资料已提交（演示）","toast.inquiry":"咨询已送出","toast.inquiryDemo":"咨询已提交（演示）","toast.failed":"提交失败，请稍后再试","toast.downloaded":"已下载占位文件",
  "meta.credits":"{n} 学分","hero.title":"亚洲宣教神学院","hero.sub":"ASIA MISSIONARY ASSOCIATION SEMINARY","hero.verse":"你们要去，使万民作我的门徒。","hero.verseRef":"— 马太福音 28:19",
  "hero.ai.title":"定制化神学 · 3 分钟看见你的信仰成长状态","hero.ai.sub":"10 道题 · 5 项初步状态 · 一条下一步建议 · 完整 Christian Profile 在 App","hero.ai.go":"立即探索 →",
  "herometa.program":"项目","herometa.programVal":"神学学士 B.Th","herometa.startVal":"2026 年 9 月","herometa.start":"2026 届开学","herometa.mode":"学习","herometa.modeVal":"线上 + 线下",
  "accred.more":"查看认证详情 →","accred.title":"学术认证与资质","accred.intro":"AMAS 的以下学位课程已通过 Asia Theological Association (ATA) 的认证评估。","accred.bthName":"神学学士 Bachelor of Theology (B.Th.)","accred.mdivName":"道学硕士 Master of Divinity (M.Div.)","accred.dminName":"教牧学博士 Doctor of Ministry (D.Min.)","accred.bthNote":"经 Asia Theological Association (ATA) 认证","accred.note":"ATA 认证适用于上述列明的学位项目；认证范围与有效期以 ATA 出具的认证文件为准。",
  "actions.consult":"咨询招生","actions.applyBth":"申请神学学士 B.Th",
  "band.status":"总校审核并建立正式学籍","band.mode":"线上课程 + 清迈线下训练","band.adm":"2026 届神学学士 B.Th 招生",
  "admissions.facts.startLabel":"开学","admissions.facts.startValue":"2026 年 9 月","admissions.facts.feeLabel":"费用","admissions.facts.feeValue":"欢迎咨询招生同工","admissions.facts.modeLabel":"模式","admissions.facts.modeValue":"线上 + 线下","admissions.facts.statusLabel":"学籍","admissions.facts.statusValue":"总校审核建立",
  "admissions.consultBtn":"先咨询，30 秒","admissions.applyBtn":"正式申请",
  "admissions.path.title1":"初次了解 AMAS？","admissions.path.title2":"从一次轻松的咨询开始。","admissions.path.s1":"快速咨询","admissions.path.s1d":"姓名 + 联系方式 + 城市 + 想了解什么","admissions.path.s2":"招生同工沟通","admissions.path.s2d":"确认课程、学籍、时间与适合程度","admissions.path.s3":"正式申请","admissions.path.s3d":"再填写完整信仰与服事资料",
  "about.title":"AMAS 亚洲宣教神学院<br>植根圣经 · 面向世界","about.body":"我们致力于以圣经真理为根基，结合跨文化视野与实践训练，装备学生成为忠心的传道人、牧者与宣教工人，在教会与世界中活出福音，见证神的国度。","about.link":"了解我们的异象与使命",
  "pillars.bible.title":"圣经为本","pillars.bible.body":"坚守圣经权威，深化真理根基，培养扎实的神学思考与属灵洞见。",
  "pillars.practice.title":"实践导向","pillars.practice.body":"理论与实践并重，课堂与事奉结合，装备学以致用的服侍能力。",
  "pillars.mission.title":"宣教视野","pillars.mission.body":"放眼全球，跨文化装备，回应大使命的呼召。",
  "pillars.life.title":"生命塑造","pillars.life.body":"注重属灵生命与品格塑造，成为合神心意的工人。",
  "stats.courses":"官方课程 · 含 13 门选修","stats.flex.title":"灵活学习","stats.flex.body":"线上线下同步学习","stats.global.title":"全球视野","stats.global.body":"跨文化学习与宣教网络","stats.team.title":"牧者团队","stats.team.body":"资深牧者与教师同行","stats.year":"2026 届神学学士 B.Th 招生启动",
  "mission.aria":"异象与使命","mission.title":"不是只完成课程，<br>而是被装备去服事。","mission.desc":"我们把神学教育放回真实的教会、家庭、职场与宣教现场，让知识、生命与行动彼此连接。",
  "mission.vision.0":"培养通过神的话语和圣灵能力得到装备的牧者和宣教士。","mission.vision.1":"在亚洲国家建立通过神的话语和圣灵能力得到装备的宣教中心。","mission.vision.2":"在亚洲国家建立重视圣经和实践的神学校，培养该国本土牧者和工人。",
  "mission.items.0.title":"扎根真理","mission.items.0.body":"建立可靠的圣经诠释与神学基础。","mission.items.1.title":"塑造生命","mission.items.1.body":"以属灵操练、群体关系与品格成长为核心。","mission.items.2.title":"训练实践","mission.items.2.body":"把所学转化为讲道、牧养、门训与服事能力。","mission.items.3.title":"回应使命","mission.items.3.body":"勇于传福音，并装备跨文化宣教的视野与能力。",
  "courses.title":"课程设置","courses.desc":"按学院官方课程体系开设必修、选修与属灵训练，涵盖圣经、系统、历史、实践神学与圣经语言。","courses.filterGroup":"课程筛选","courses.filters.all":"全部","courses.filters.bible":"圣经","courses.filters.theology":"神学","courses.filters.ministry":"实践事工","courses.filters.mission":"宣教","courses.filters.formation":"生命塑造","courses.count":"已显示 {n} 门课程","courses.more":"展开全部课程（还有 {n} 门）","courses.less":"收起课程列表",
  "courseCards.0.title":"圣经综合概观","courseCards.0.body":"纵览全本圣经的结构、脉络与救赎主线。","courseCards.1.title":"马太福音","courseCards.1.body":"研读天国的信息，认识君王基督与门徒之道。","courseCards.2.title":"约翰福音","courseCards.2.body":"认识耶稣的身份与工作，因信祂的名得生命。","courseCards.3.title":"使徒行传","courseCards.3.body":"跟随初代教会的脚踪，看福音从耶路撒冷直到地极。","courseCards.4.title":"罗马书","courseCards.4.body":"系统研读因信称义的福音大纲与新生命之道。","courseCards.5.title":"哥林多前书","courseCards.5.body":"围绕教会秩序、十字架神学与群体建造研读书信。","courseCards.6.title":"哥林多后书","courseCards.6.body":"在软弱中认识神的安慰、能力与事奉者的职分。","courseCards.7.title":"以弗所书","courseCards.7.body":"认识教会作为基督身体的奥秘与在基督里的新生活。","courseCards.8.title":"希伯来书","courseCards.8.body":"仰望更美的大祭司基督，持定所承认的指望。","courseCards.9.title":"启示录","courseCards.9.body":"从启示文学认识终末盼望与教会的得胜。",
  "courseCards.10.title":"系统神学1","courseCards.10.body":"面向平信徒与初阶学员的教义总览，建立信仰框架。","courseCards.11.title":"处境化神学","courseCards.11.body":"在亚洲处境中忠于圣经地思考、表达与实践信仰。","courseCards.12.title":"传道","courseCards.12.body":"掌握传福音的信息、方法与陪谈跟进之道。","courseCards.13.title":"牧会相谈","courseCards.13.body":"学习倾听、辅导与属灵陪伴的基本功。","courseCards.14.title":"小组","courseCards.14.body":"建立、带领与倍增健康的小组群体。","courseCards.15.title":"新信徒事工","courseCards.15.body":"以系统教材陪伴初信者扎根信仰、融入教会。","courseCards.16.title":"教会运营","courseCards.16.body":"从治理、同工配搭到事工规划的教会运营实务。","courseCards.17.title":"礼拜学","courseCards.17.body":"认识崇拜的圣经意义与礼拜程序的安排。","courseCards.18.title":"内在医治","courseCards.18.body":"在真理与圣灵里经历内心创伤的医治与释放。","courseCards.19.title":"医治疾病","courseCards.19.body":"从圣经根基认识医治祷告的原则与实践。","courseCards.20.title":"神的话语医治","courseCards.20.body":"学习以神的话语宣告、代祷并牧养病痛中的人。","courseCards.21.title":"属灵争战","courseCards.21.body":"认识属灵争战的圣经原则，穿戴神所赐的全副军装。","courseCards.22.title":"基督徒生活","courseCards.22.body":"在日常生活中操练信仰、敬虔与见证。","courseCards.23.title":"平信徒养育（门徒）","courseCards.23.body":"以门徒的身份跟随基督，建立稳定的生命节奏。","courseCards.24.title":"平信徒养育（确信）","courseCards.24.body":"建立救恩确据，活出稳固而有盼望的信仰根基。",
  "programs.title":"培养项目","programs.desc":"学分制 · 按科修读、按科缴费：从证书课程到博士研究，修满学分即可毕业；2026 届 B.Th 招生已开放，其余项目已开放，如若了解，可更多咨询。",
  "programs.degree.title":"学位课程","programs.degree.sub":"学分制逐科修读，修满规定学分即毕业；学籍由 AMAS 总校审核建立","programs.equip.title":"证书与装备课程","programs.equip.sub":"面向在职牧者与平信徒的短期训练",
  "programs.items.laycert.badge":"证书","programs.items.laycert.name":"平信徒指导者课程","programs.items.laycert.desc":"36 学分 · 每 3 个月集中学习 10 天 · 修满即结业","programs.items.pdip.badge":"文凭","programs.items.pdip.name":"牧会训练课程","programs.items.pdip.desc":"60 学分 · 可在线按科学习 · 修毕获结业证","application.programs.laycert":"平信徒指导者课程（证书）","application.programs.pdip":"牧会训练课程（文凭）",
  "programs.items.bth.name":"神学学士","programs.items.bth.desc":"2026 届招生 · 2026 年 9 月开学 · 90 学分 · 按科修读、线上 + 线下",
  "programs.items.gdip.name":"教牧学研究硕士","programs.items.gdip.desc":"90 学分 · 按科修读 · 补修学分可衔接 M.Div",
  "programs.items.mdiv.name":"道学硕士","programs.items.mdiv.desc":"90 学分 · 按科修读 · 面向全职事奉的完整神学与教牧装备",
  "programs.items.dmin.name":"教牧学博士 / 宣教学博士","programs.items.dmin.desc":"D.Min / D.Miss · 48 学分（含论文）· 按学分完成研究与实践",
  "programs.items.pastor.badge":"进修","programs.items.pastor.name":"牧会者进修","programs.items.pastor.desc":"在职牧者的持续装备与更新",
  "programs.items.preaching.badge":"讲道","programs.items.preaching.name":"讲道学校","programs.items.preaching.desc":"从释经到宣讲的集中训练",
  "programs.items.missionary.badge":"宣教","programs.items.missionary.name":"宣教士训练","programs.items.missionary.desc":"跨文化事奉的呼召分辨与差派预备",
  "programs.note":"各项目的开课批次、修读年限与申请条件，请通过「申请入学」或联系方式咨询招生同工。",
  "nav.programs":"培养项目",
  "digital.title":"数字校园","digital.desc":"学院正在建设自己的学习平台，把课程、资源与群体连接在同一个入口。",
  "digital.items.0.title":"远程课堂","digital.items.0.body":"正在修读的课程、直播讲座与课后回放汇总到一个入口，适合移动端连续学习。",
  "digital.items.1.title":"图书馆资源","digital.items.1.body":"讲义、音频与研究资料在图书馆与课程资料页同步出现，减少来回查找。",
  "digital.items.2.title":"校友社群","digital.items.2.body":"讨论、代祷、导师反馈与语音房，让学习与群体生活彼此连接。",
  "digital.ai.cta":"3 分钟快速探索 · 抢先体验","digital.ai.ctaNote":"完整 Christian Profile（12 项事奉倾向 · 四层分别测量）在 App 端建立。",
  "digital.app.web":"打开网页版 App",
  "digital.ai.title":"定制化神学 · AI 个性化装备","digital.ai.quote":"“不是每个人都需要从同一课开始。”","digital.ai.body":"AI 将根据你的信仰、圣经、神学、生命与服事处境进行对话式评估，生成你的神学成长画像，并为你设计专属的装备路径——学习中持续评估、动态调整，直到差遣你进入真实服事。","digital.ai.f0":"认识你","digital.ai.f1":"评估","digital.ai.f2":"成长画像","digital.ai.f3":"专属路径","digital.ai.f4":"持续调整","digital.items.3.title":"课程试听","digital.items.3.body":"精选免费公开课先听为快，体验课堂再决定报读。","digital.items.4.title":"课程路径","digital.items.4.body":"从证书课程到博士研究，阶梯式路径一目了然。","digital.items.5.title":"在线咨询","digital.items.5.body":"公告、答疑与招生咨询随时在手，同工及时回应。",
  "digital.note.label":"开发中：","digital.note.body":"学习 App 正在内部测试，正式发布后将在此提供下载入口。",
  "admissions.title":"2026 届神学学士 B.Th 招生","admissions.desc":"为愿意认真装备、持续成长并参与服事的人提供灵活、实践导向的神学教育路径。","tuition.title":"学费与学习支持","tuition.motto":"让愿意接受装备的人，都有继续学习的道路。","tuition.mode":"按科修读 · 按科缴费",
  "tuition.p1":"AMAS 采用按科修读、按科缴费的方式。学员根据自己的学习进度选修课程，不需要一次承担整学期或整学年的费用，让学习安排更加灵活，也减轻一次性经济压力。具体课程费用，请亲自向招生同工咨询了解。",
  "tuition.p2":"我们相信，神学装备需要学员认真投入，也需要学校、教师与服事团队共同承担教学成本。因此，正常缴纳课程费用，是对学习的委身，也是对教学事工的支持。",
  "tuition.v1":"“人若有愿作的心，必蒙悦纳，乃是照他所有的，并不是照他所无的。”","tuition.v1ref":"—— 哥林多后书 8:12",
  "tuition.p3":"因此，经济上的困难不应成为一个人接受神学装备的拦阻。对于确有经济困难、但愿意认真学习并接受装备的学员，可以主动向招生或教务同工说明实际情况，学校会根据个人情况，提供适当的学费减免、分期缴费或其他学习支持方案。",
  "tuition.p4":"我们的原则不是简单地“降低学费”，而是希望每一位真正愿意学习的人，都能够找到一条可以继续装备的道路。",
  "tuition.v2":"“在道理上受教的，当把一切需用的供给施教的人。”","tuition.v2ref":"—— 加拉太书 6:6",
  "tuition.p5":"AMAS 盼望建立健康的学习文化：有能力的学员正常承担学费；有困难的学员可以获得帮助；有余力的人也可以通过<a href=\"#giving\">奉献支持</a>其他学员接受装备。",
  "tuition.ctaFee":"了解课程费用","tuition.ctaAid":"申请学习支持",
  "tuition.pr.title":"学费原则","tuition.pr.0":"课程费用按科计算，具体金额请亲自咨询招生同工","tuition.pr.1":"按科缴费，不要求一次缴清全年费用","tuition.pr.2":"经济困难者可申请个别评估与学习支持","tuition.pr.3":"学校不会单纯因为经济困难而拒绝一个认真寻求装备的学员","tuition.pr.4":"具体减免、分期及支持方式由学校个别沟通决定",
  "life.title":"学习不是孤立发生的。","life.desc":"课堂、门训、小组、教会服事与真实生活共同构成神学教育。","life.items.0.title":"导师同行","life.items.0.body":"课程之外，重视生命陪伴与方向辨识。","life.items.0.p0":"定期的一对一生命陪伴与代祷","life.items.0.p1":"学习方向与服事召命的辨识","life.items.0.p2":"与资深牧者同行的属灵网络","life.items.1.title":"小组学习","life.items.1.body":"透过讨论、案例与彼此回应深化学习。","life.items.1.p0":"固定学习小组，彼此守望同行","life.items.1.p1":"课程讨论、案例分享与彼此回应","life.items.1.p2":"跨地区学员的线上团契生活","life.items.2.title":"实践服事","life.items.2.body":"把所学带入教会、家庭、职场与宣教现场。","life.items.2.p0":"与本地教会配搭的服事岗位","life.items.2.p1":"传道、门训、探访等实践安排","life.items.2.p2":"清迈线下密集训练与实践周","life.items.3.title":"敬拜与灵修","life.items.3.body":"在敬拜与祷告中扎根，生命先于事奉。","life.items.3.p0":"规律的灵修与祷告操练","life.items.3.p1":"参与崇拜聚会与礼拜服事","life.items.3.p2":"在群体中培养敬虔与品格",
  "life.rhythm.title":"每周学习节奏","life.rhythm.0":"线上课程与阅读作业","life.rhythm.1":"小组讨论与彼此回应","life.rhythm.2":"门训与导师时间","life.rhythm.3":"教会服事与生活实践",
  "resources.title":"资源中心","resources.searchLabel":"搜索资源","resources.searchPlaceholder":"搜索资源…","resources.count":"找到 {n} 项资源","resources.items.0":"新生入学手册","resources.items.1":"B.Th 课程目录","resources.items.2":"学费与学习支持","resources.items.3":"在线申请（快速通道）","resources.items.4":"入学申请表（完整版 Word）","resources.items.5":"上传已填写的申请表","actions.upload":"上传 ↑","upload.name":"姓名","upload.contact":"联系方式（邮箱 / 微信 / 电话）","upload.file":"选择已填写的申请表（Word 或 PDF）","upload.submit":"上传并提交","upload.note":"资料将直接发送至招生同工邮箱；提交后会在新页面显示确认。",
  "courseCards.25.title":"系统神学2","courseCards.25.body":"续论基督论与救恩论等核心教义。","courseCards.26.title":"系统神学3","courseCards.26.body":"教会论与末世论等教义的整全建构。","courseCards.27.title":"以色列的文化","courseCards.27.body":"认识圣经背景中的以色列历史与文化。","courseCards.28.title":"世界教会史","courseCards.28.body":"纵览两千年教会的历程与属灵传承。","courseCards.29.title":"中国教会史","courseCards.29.body":"回顾福音入华与中国教会的成长之路。","courseCards.30.title":"希腊文","courseCards.30.body":"学习新约希腊文基础，直读原文经文。","courseCards.31.title":"希伯来语基础","courseCards.31.body":"掌握旧约希伯来文的入门要素。","courseCards.32.title":"新信徒教育教材","courseCards.32.body":"编写与使用初信栽培教材的实务。","courseCards.33.title":"讲道学","courseCards.33.body":"从释经到信息构成，学习忠实清晰的讲道。","courseCards.34.title":"讲道实习1","courseCards.34.body":"在实际讲台操练中打磨讲道基本功。","courseCards.35.title":"讲道实习2","courseCards.35.body":"进阶讲道操练与讲评，形成个人讲道风格。","courseCards.36.title":"带领赞美的方法","courseCards.36.body":"学习带领会众赞美敬拜的原则与技巧。","courseCards.37.title":"1日内在医治","courseCards.37.body":"一天密集的内在医治实践课程。","courseCards.38.title":"电脑应用","courseCards.38.body":"事奉所需的文书、简报与网络工具应用。","courseCards.39.title":"创世记","courseCards.39.body":"从起初认识创造、堕落与救赎的开端。","courseCards.40.title":"利未记","courseCards.40.body":"借献祭与节期认识圣洁与敬拜的真义。","courseCards.41.title":"基督教伦理","courseCards.41.body":"以圣经原则回应当代伦理议题。","courseCards.42.title":"儿童教育","courseCards.42.body":"儿童事工与信仰教育的理念与实务。","courseCards.43.title":"宗教比较","courseCards.43.body":"认识主要宗教，持定福音的独特。","courseCards.44.title":"对伊斯兰的理解","courseCards.44.body":"认识伊斯兰信仰与向穆斯林传福音。","courseCards.45.title":"三人教会","courseCards.45.body":"以最小单位开始教会的植堂策略。","courseCards.46.title":"圣经地理","courseCards.46.body":"借地理场景读懂圣经叙事。","courseCards.47.title":"世界观理解","courseCards.47.body":"辨析各样世界观，建立圣经的眼光。","courseCards.48.title":"牧会成功与失败案例","courseCards.48.body":"从真实牧会案例汲取经验与警戒。","courseCards.49.title":"领导力","courseCards.49.body":"属灵领导力的品格与实践。","courseCards.50.title":"中国的异端","courseCards.50.body":"辨识异端邪说，持守纯正信仰。","courseCards.51.title":"能力祷告","courseCards.51.body":"学习满有能力的祷告生活与服事。","courses.filters.history":"历史","courses.filters.language":"语言","courses.filters.elective":"选修","training.0":"通读圣经训练（3 次）","training.1":"背诵圣经训练","training.2":"家庭礼拜训练","training.3":"人际关系训练","training.4":"奉献训练","training.5":"讲道作成 100 篇（600 页以上）","training.6":"每天祈祷 1 小时（每 100 天 1 学分）","training.7":"传道（每带领 5 人 1 学分）","training.8":"Q.T 灵修训练（每 100 天 1 学分）","training.9":"晨祷（每 100 天 1 学分）","training.10":"开辟教会","training.title":"属灵训练与毕业要求","training.note":"硕士班（G.Dip / M.Div）毕业学分为 90 分；以下训练项目由学校检查认定学分。","training.unit":"学分",
  "verse.courses":"“你当竭力在神面前得蒙喜悦，作无愧的工人，按着正意分解真理的道。”","verse.coursesRef":"— 提摩太后书 2:15","verse.adm":"“来跟从我，我要叫你们得人如得鱼一样。”","verse.admRef":"— 马太福音 4:19","verse.life":"“铁磨铁，磨出刃来；朋友相感也是如此。”","verse.lifeRef":"— 箴言 27:17","verse.digital":"“你的话是我脚前的灯，是我路上的光。”","verse.digitalRef":"— 诗篇 119:105","verse.res":"“圣经都是神所默示的，于教训、督责、使人归正、教导人学义都是有益的。”","verse.resRef":"— 提摩太后书 3:16",
  "footer.desc":"植根圣经、扎根祷告，装备走向亚洲禾场的工人。清迈教学中心与线上课堂，共同服务华人教会与跨文化宣教。","footer.c1":"学院","footer.c2":"学习","footer.c3":"开始",
  "faq.title":"常见问题","faq.items.0.q":"没有神学背景可以申请吗？","faq.items.0.a":"可以。我们更看重持续学习、遵守学习纪律与认真接受装备的意愿。","faq.items.1.q":"课程全部线上吗？","faq.items.1.a":"以灵活学习为原则，包含线上课程，同时鼓励参与清迈线下门训、实践与群体学习。","faq.items.2.q":"完成后由谁建立学籍和颁发学位？","faq.items.2.a":"学籍由 AMAS 总校审核建立，并按学校正式制度完成毕业与学位流程。","faq.items.3.q":"如何开始申请？","faq.items.3.a":"点击“申请入学”，填写基础资料与学习动机，之后由招生同工联络并说明下一步。",
  "giving.cta":"了解参与方式","giving.ctaNote":"具体方式由同工一对一说明。",
  "giving.title":"奉献支持","giving.verse":"“各人要随本心所酌定的，不要作难，不要勉强，因为捐得乐意的人是神所喜爱的。”","giving.verseRef":"—— 哥林多后书 9:7","giving.desc":"神学教育是一场同工的事奉。你的奉献将帮助愿意受装备的学员走完学习的路，也支持教学与宣教事工继续前行。","giving.d1":"学员助学","giving.d1b":"资助经济困难的学员完成装备","giving.d2":"教学事工","giving.d2b":"支持教师团队与课程建设","giving.d3":"宣教士训练","giving.d3b":"支持差派预备中的工人","giving.ok":"已收到，愿主纪念你的摆上！","giving.fail":"发送失败，请稍后再试，或直接联系我们。","giving.note":"奉献完全出于自愿，用于学员助学、教学与宣教事工；如需了解奉献的使用情况，欢迎随时与我们联系。","faq.items.4.q":"我可以怎样支持 AMAS？","faq.items.4.a":"欢迎以代祷参与，也可以为学员助学、教学与宣教事工奉献，详见「奉献支持」版块；把学院介绍给身边合适的人同样是宝贵的支持。",
  "promo.tab":"2026 届招生进行中","promo.title":"2026 届神学学士 B.Th 招生中","promo.desc":"线上 + 清迈线下 · 按科修读 · 9 月开学。想先了解一下？招生助手随时为你解答。","promo.ask":"立即咨询","promo.apply":"申请入学","admissions.countdown":"2026 年 9 月开学 · 2026 届招生进行中","admissions.started":"2026 届已开学，欢迎咨询下一批次","actions.copy":"复制","toast.copied":"已复制","faq.ask.title":"还有其他问题？","faq.ask.desc":"AI 咨询助手可以随时解答；也可以直接留言给招生同工，我们会尽快回复你。","faq.ask.ai":"问 AI 咨询助手","faq.ask.leave":"给招生同工留言",
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
  "application.programs.bth":"神学学士 B.Th（2026 届招生）","application.programs.gdip":"教牧学研究硕士 G.DIP","application.programs.mdiv":"道学硕士 M.DIV","application.programs.dmin":"教牧学 / 宣教学博士 D.MIN / D.MISS","application.programs.pastor":"牧会者进修","application.programs.preaching":"讲道学校","application.programs.missionary":"宣教士训练",
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
  "chat.chips.human":"Talk to a Person","chat.human.intro":"Sure — you can reach our admissions team directly (we usually reply the same day):","chat.human.wechat":"WeChat {id} · tap to copy","chat.human.line":"Line {id} · tap to copy","chat.human.note":"Please mention \u201cAMAS inquiry\u201d when adding us. You can also leave a message here and we will contact you.",
  "chat.kb.apply":"Click Apply and complete the online form (about 3 minutes). The admissions team will contact you with next steps. A full Word application form is also available in Resources.",
  "chat.kb.tuition":"Tuition is charged per course, paid course by course. For specific amounts, please contact our admissions team directly. Students facing financial hardship may ask about fee reduction, instalments or other learning support.","chat.kb.tuitionBtn":"Tuition & support",
  "chat.kb.courses":"The official curriculum offers 52 courses (including 13 electives) plus spiritual-training items; the G.Dip / M.Div track graduates with 90 credits, spanning Bible, theology, history, ministry and biblical languages.","chat.kb.coursesBtn":"Browse courses",
  "chat.kb.programs":"Degree programs are credit-based and taken course by course: B.Th (90 credits), G.Dip / Master of Ministry Studies (90), M.Div (90) and D.Min / D.Miss (48); certificate and equipping tracks: Lay Leader Course, Pastoral Training Diploma, pastoral continuing education, School of Preaching and Missionary Training. The B.Th Class of 2026 intake is open; classes start in September 2026.","chat.kb.programsBtn":"View programs",
  "chat.kb.mode":"Flexible online + in-person study: online coursework combined with in-person discipleship in Chiang Mai. The B.Th Class of 2026 intake starts in September 2026.",
  "chat.kb.contact":"You can reach us via:","chat.kb.contactEmpty":"Contact details will be published soon. You can leave a message right here, or use the inquiry form at the bottom of the page.",
  "chat.kb.location":"The teaching center is in Chiang Mai, Thailand, with online study available.",
  "chat.kb.video":"We have an introduction video you can watch.",
  "chat.leave.askName":"Happy to pass that on. What is your name?","chat.leave.askContact":"Please leave your contact (WeChat / email / phone):","chat.leave.askContent":"What would you like to tell the admissions team?",
  "chat.leave.done":"Message sent — the admissions team will reply soon. Anything else?","chat.leave.doneDemo":"Message saved (demo mode; it will reach the admissions team once the site goes live). Anything else?","chat.leave.fail":"Sorry, sending failed. Please try again later or use the inquiry form at the bottom of the page.",
  "brand.sub":"CHIANG MAI TEACHING CENTER","brand.zoom":"View the school seal","brand.sealSub":"Asia Missionary Association Seminary · Thailand",
  "announce.brand":"AMAS · Chiang Mai Teaching Center","announce.verse":"\"Whom shall I send? And who will go for us?\" \"Here am I. Send me!\" — Isaiah 6:8","announce.moto":"Equipping disciples today · Sending missionaries tomorrow","announce.hot":"2026 B.Th Admissions","announce.link":"Admissions Info →",
  "nav.home":"Home","nav.about":"About","nav.courses":"Courses","nav.admissions":"Admissions","nav.tuition":"Tuition","nav.life":"Student Life","nav.resources":"Resources","nav.contact":"Contact",
  "actions.apply":"Apply","actions.login":"Log In","actions.video":"Watch Introduction","actions.applyNow":"Apply Now","actions.download":"Download ↓","actions.view":"View →","actions.fill":"Fill in →","actions.skip":"Skip to main content","actions.backToTop":"↑ TOP","actions.close":"Close","actions.sending":"Sending…",
  "a11y.themeToNight":"Switch to night mode","a11y.themeToDay":"Switch to day mode","a11y.themeNight":"Night mode","a11y.themeDay":"Day mode","a11y.langSwitch":"Switch language (currently English)","a11y.openMenu":"Open menu","a11y.closeMenu":"Close menu",
  "toast.themeNight":"Night mode on","toast.themeDay":"Day mode on","toast.applied":"Application sent","toast.appliedDemo":"Application submitted (demo)","toast.inquiry":"Inquiry sent","toast.inquiryDemo":"Inquiry submitted (demo)","toast.failed":"Submission failed, please try again","toast.downloaded":"Placeholder file downloaded",
  "meta.credits":"{n} Credits","hero.title":"Asia Missionary Association Seminary","hero.sub":"亚洲宣教神学院 · CHIANG MAI, THAILAND","hero.verse":"Go therefore and make disciples of all nations.","hero.verseRef":"— Matthew 28:19",
  "hero.ai.title":"Personalized Theology · See your faith-growth status in 3 minutes","hero.ai.sub":"10 questions · 5 quick indicators · one next step · full Christian Profile in the App","hero.ai.go":"Start exploring →",
  "herometa.program":"Program","herometa.programVal":"B.Th — Bachelor of Theology","herometa.startVal":"September 2026","herometa.start":"Class of 2026 starts","herometa.mode":"Format","herometa.modeVal":"Online + On-site",
  "accred.more":"View accreditation →","accred.title":"Academic Accreditation","accred.intro":"The following degree programs of AMAS have been accredited by the Asia Theological Association (ATA).","accred.bthName":"Bachelor of Theology (B.Th.)","accred.mdivName":"Master of Divinity (M.Div.)","accred.dminName":"Doctor of Ministry (D.Min.)","accred.bthNote":"Accredited by the Asia Theological Association (ATA)","accred.note":"ATA accreditation applies to the degree programs listed above; the scope and validity of accreditation are as stated in the official ATA accreditation documents.",
  "actions.consult":"Admissions Inquiry","actions.applyBth":"Apply for B.Th",
  "band.status":"Official student status registered by the main campus","band.mode":"Online courses + on-site training in Chiang Mai","band.adm":"B.Th Class of 2026 intake",
  "admissions.facts.startLabel":"Starts","admissions.facts.startValue":"September 2026","admissions.facts.feeLabel":"Fee","admissions.facts.feeValue":"Please ask our admissions team","admissions.facts.modeLabel":"Mode","admissions.facts.modeValue":"Online + On-site","admissions.facts.statusLabel":"Student status","admissions.facts.statusValue":"Registered by the main campus",
  "admissions.consultBtn":"Quick inquiry — 30 sec","admissions.applyBtn":"Formal application",
  "admissions.path.title1":"New to AMAS?","admissions.path.title2":"Start with a simple conversation.","admissions.path.s1":"Quick inquiry","admissions.path.s1d":"Name + contact + city + what you'd like to know","admissions.path.s2":"Talk with admissions","admissions.path.s2d":"Confirm courses, student status, schedule and fit","admissions.path.s3":"Formal application","admissions.path.s3d":"Then complete the full faith and ministry form",
  "about.title":"AMAS Chiang Mai<br>Rooted in Scripture · Facing the World","about.body":"We provide Scripture-rooted, practice-oriented theological education that forms knowledge, character and ministry skills for faithful service in church, work and mission.","about.link":"Discover our vision and mission",
  "pillars.bible.title":"Biblical Foundation","pillars.bible.body":"Deep confidence in Scripture, careful interpretation and sound theological thinking.",
  "pillars.practice.title":"Practice Oriented","pillars.practice.body":"Connecting classroom learning with ministry, service and real-world questions.",
  "pillars.mission.title":"Mission Vision","pillars.mission.body":"A global, cross-cultural perspective shaped by the Great Commission.",
  "pillars.life.title":"Life Formation","pillars.life.body":"Spiritual life, character and faithful habits formed in community.",
  "stats.courses":"Official courses · 13 electives","stats.flex.title":"Flexible Learning","stats.flex.body":"Online + in-person","stats.global.title":"Global Vision","stats.global.body":"Cross-cultural mission network","stats.team.title":"Pastoral Faculty","stats.team.body":"Mentors and teachers","stats.year":"B.Th Class of 2026 intake",
  "mission.aria":"Vision and mission","mission.title":"Education is not just completed.<br>It becomes faithful service.","mission.desc":"We place theology back into church, family, workplace and mission so knowledge, formation and action stay connected.",
  "mission.vision.0":"Raise pastors and missionaries equipped through the Word of God and the power of the Holy Spirit.","mission.vision.1":"Establish mission centers across Asian nations, equipped through the Word and the Spirit.","mission.vision.2":"Establish Bible-centered, practice-oriented seminaries in Asian nations, raising local pastors and workers.",
  "mission.items.0.title":"Rooted in Truth","mission.items.0.body":"Build reliable biblical interpretation and theological foundations.","mission.items.1.title":"Formed in Life","mission.items.1.body":"Grow through spiritual disciplines, community and character.","mission.items.2.title":"Trained in Practice","mission.items.2.body":"Translate learning into preaching, pastoral care and discipleship.","mission.items.3.title":"Sent in Mission","mission.items.3.body":"Share the gospel courageously and serve across cultures.",
  "courses.title":"Curriculum","courses.desc":"The official curriculum: required courses, electives and spiritual training across Bible, systematic, historical, practical theology and biblical languages.","courses.filterGroup":"Filter courses","courses.filters.all":"All","courses.filters.bible":"Bible","courses.filters.theology":"Theology","courses.filters.ministry":"Ministry","courses.filters.mission":"Mission","courses.filters.formation":"Formation","courses.count":"{n} courses shown","courses.more":"Show all courses ({n} more)","courses.less":"Show fewer courses",
  "courseCards.0.title":"Bible Survey","courseCards.0.body":"A panoramic overview of the structure, storyline and redemptive thread of Scripture.","courseCards.1.title":"Gospel of Matthew","courseCards.1.body":"Study the message of the Kingdom, Christ the King and the way of discipleship.","courseCards.2.title":"Gospel of John","courseCards.2.body":"Know who Jesus is and receive life by believing in His name.","courseCards.3.title":"Acts","courseCards.3.body":"Follow the early church as the gospel spreads from Jerusalem to the ends of the earth.","courseCards.4.title":"Romans","courseCards.4.body":"A systematic study of justification by faith and life in the Spirit.","courseCards.5.title":"1 Corinthians","courseCards.5.body":"Church order, the theology of the cross and community building.","courseCards.6.title":"2 Corinthians","courseCards.6.body":"God's comfort and power in weakness, and the nature of gospel ministry.","courseCards.7.title":"Ephesians","courseCards.7.body":"The mystery of the church as the body of Christ and the new life in Him.","courseCards.8.title":"Hebrews","courseCards.8.body":"Look to Christ our great High Priest and hold fast the hope we profess.","courseCards.9.title":"Revelation","courseCards.9.body":"Eschatological hope and the victory of the church through apocalyptic literature.",
  "courseCards.10.title":"Systematic Theology I","courseCards.10.body":"A doctrinal overview for lay believers and beginning students.","courseCards.11.title":"Contextual Theology","courseCards.11.body":"Thinking and living the faith faithfully within Asian contexts.","courseCards.12.title":"Evangelism","courseCards.12.body":"Master the message, methods and follow-up of sharing the gospel.","courseCards.13.title":"Pastoral Counseling","courseCards.13.body":"Foundations of listening, counseling and spiritual accompaniment.","courseCards.14.title":"Small Groups","courseCards.14.body":"Build, lead and multiply healthy small groups.","courseCards.15.title":"New Believers Ministry","courseCards.15.body":"Walk with new believers as they take root in faith and church life.","courseCards.16.title":"Church Administration","courseCards.16.body":"Practical church governance, team building and ministry planning.","courseCards.17.title":"Worship & Liturgy","courseCards.17.body":"The biblical meaning of worship and the ordering of the service.","courseCards.18.title":"Inner Healing","courseCards.18.body":"Experience healing of inner wounds in truth and by the Spirit.","courseCards.19.title":"Healing Ministry","courseCards.19.body":"Biblical foundations and practice of prayer for healing.","courseCards.20.title":"Healing through God's Word","courseCards.20.body":"Declare God's Word, intercede and shepherd those who are ill.","courseCards.21.title":"Spiritual Warfare","courseCards.21.body":"Biblical principles of spiritual warfare and the whole armor of God.","courseCards.22.title":"Christian Living","courseCards.22.body":"Practice faith, godliness and witness in everyday life.","courseCards.23.title":"Lay Formation: Discipleship","courseCards.23.body":"Follow Christ as a disciple with steady rhythms of life.","courseCards.24.title":"Lay Formation: Assurance","courseCards.24.body":"Build assurance of salvation and a firm, hopeful foundation of faith.",
  "programs.title":"Programs","programs.desc":"Credit-based, course by course: from certificate to doctoral study, graduate on completing the required credits. The B.Th Class of 2026 intake is open; the other programs are open as well — contact us to learn more.",
  "programs.degree.title":"Degree Programs","programs.degree.sub":"Credit-based study course by course; graduate on completing the required credits. Enrolment is verified by AMAS headquarters.","programs.equip.title":"Certificate & Equipping Programs","programs.equip.sub":"Short-term training for serving pastors and lay leaders",
  "programs.items.laycert.badge":"CERT","programs.items.laycert.name":"Lay Leader Course","programs.items.laycert.desc":"36 credits · a 10-day intensive every 3 months · complete on full credits","programs.items.pdip.badge":"DIP","programs.items.pdip.name":"Pastoral Training Diploma","programs.items.pdip.desc":"60 credits · online, course by course · certificate of completion","application.programs.laycert":"Lay Leader Course (Certificate)","application.programs.pdip":"Pastoral Training Diploma",
  "programs.items.bth.name":"Bachelor of Theology","programs.items.bth.desc":"Class of 2026 · starts September 2026 · 90 credits · course by course, online + in-person",
  "programs.items.gdip.name":"Master of Ministry Studies (G.Dip)","programs.items.gdip.desc":"90 credits · course by course · additional credits bridge to the M.Div",
  "programs.items.mdiv.name":"Master of Divinity","programs.items.mdiv.desc":"90 credits · course by course · full theological and pastoral equipping for vocational ministry",
  "programs.items.dmin.name":"Doctor of Ministry / Missiology","programs.items.dmin.desc":"D.Min / D.Miss · 48 credits incl. dissertation · credit-based research and practice",
  "programs.items.pastor.badge":"CE","programs.items.pastor.name":"Pastoral Continuing Education","programs.items.pastor.desc":"Ongoing equipping and renewal for serving pastors",
  "programs.items.preaching.badge":"PR","programs.items.preaching.name":"School of Preaching","programs.items.preaching.desc":"Intensive training from exegesis to proclamation",
  "programs.items.missionary.badge":"MI","programs.items.missionary.name":"Missionary Training","programs.items.missionary.desc":"Discerning the call and preparing for cross-cultural sending",
  "programs.note":"For intake schedules, duration and entry requirements of each program, apply online or contact the admissions team.",
  "nav.programs":"Programs",
  "digital.title":"Digital Campus","digital.desc":"The seminary is building its own learning platform, connecting courses, resources and community in one place.",
  "digital.items.0.title":"Remote Classroom","digital.items.0.body":"Current courses, live lectures and replays gathered into one entry point for continuous mobile learning.",
  "digital.items.1.title":"Library Resources","digital.items.1.body":"Notes, audio and research materials appear in both the library and course pages.",
  "digital.items.2.title":"Alumni Community","digital.items.2.body":"Discussion, intercession, mentor feedback and voice rooms connect learning with community life.",
  "digital.ai.cta":"Try the 3-Minute Quick Exploration","digital.ai.ctaNote":"The full Christian Profile (12 ministry orientations, four layers measured separately) is built in the App.",
  "digital.app.web":"Open the Web App",
  "digital.ai.title":"Personalized Theology · AI Equipping","digital.ai.quote":"\u201cNot everyone needs to start from the same course.\u201d","digital.ai.body":"Through conversational assessment of your faith, Bible knowledge, theology, life and ministry context, AI builds your theological growth profile and designs a personal equipping path \u2014 continually re-evaluated and adjusted, until you are sent into real ministry.","digital.ai.f0":"Know you","digital.ai.f1":"Assess","digital.ai.f2":"Growth profile","digital.ai.f3":"Personal path","digital.ai.f4":"Keep adjusting","digital.items.3.title":"Course Trials","digital.items.3.body":"Sample selected free open courses before you enroll.","digital.items.4.title":"Study Pathways","digital.items.4.body":"See the ladder from certificate to doctoral studies at a glance.","digital.items.5.title":"Online Support","digital.items.5.body":"Announcements, Q&A and admissions help, right in your pocket.",
  "digital.note.label":"In development: ","digital.note.body":"The learning app is in internal testing; a download link will appear here at launch.",
  "admissions.title":"B.Th Class of 2026 Admissions","admissions.desc":"A flexible, practice-oriented theological pathway for learners committed to growth and service.","tuition.title":"Tuition & Learning Support","tuition.motto":"May everyone who is willing to be equipped find a way to keep learning.","tuition.mode":"Course by Course · Pay per Course",
  "tuition.p1":"AMAS charges per course, paid course by course. Students take courses at their own pace without bearing a whole semester's or year's fees at once — keeping study flexible and easing upfront financial pressure. For specific course fees, please contact our admissions team directly.",
  "tuition.p2":"We believe theological formation calls for real commitment from students, while the school, faculty and ministry team share the cost of teaching. Paying course fees faithfully is both a commitment to learning and a support to the teaching ministry.",
  "tuition.v1":"“For if the willingness is there, the gift is acceptable according to what one has, not according to what one does not have.”","tuition.v1ref":"— 2 Corinthians 8:12",
  "tuition.p3":"Therefore, financial difficulty should never keep anyone from theological formation. Students facing genuine hardship who are committed to serious study may speak with our admissions or academic staff. The school will review each situation individually and offer appropriate fee reduction, instalment plans or other learning support.",
  "tuition.p4":"Our principle is not simply to “lower tuition”, but to help everyone who truly wants to learn find a path to continue being equipped.",
  "tuition.v2":"“The one who is taught the word must share all good things with the one who teaches.”","tuition.v2ref":"— Galatians 6:6",
  "tuition.p5":"AMAS hopes to build a healthy learning culture: those who are able pay tuition faithfully; those in hardship receive help; and those with abundance may support other students through <a href=\"#giving\">giving</a>.",
  "tuition.ctaFee":"Course fees","tuition.ctaAid":"Apply for learning support",
  "tuition.pr.title":"Tuition Principles","tuition.pr.0":"Fees are charged per course — please ask admissions for details","tuition.pr.1":"Pay per course — no full-year payment required","tuition.pr.2":"Individual review and learning support available for financial hardship","tuition.pr.3":"No sincere seeker of formation is turned away merely for financial reasons","tuition.pr.4":"Specific reductions, instalments and support are arranged individually with the school",
  "life.title":"Learning never happens alone.","life.desc":"Classes, mentoring, groups, church ministry and everyday life all shape theological education.","life.items.0.title":"Mentoring","life.items.0.body":"Guidance for life, calling and discernment beyond the classroom.","life.items.0.p0":"Regular one-on-one accompaniment and prayer","life.items.0.p1":"Discernment of study direction and calling","life.items.0.p2":"A network of seasoned pastors walking alongside","life.items.1.title":"Group Learning","life.items.1.body":"Discussion, cases and mutual response deepen understanding.","life.items.1.p0":"Fixed study groups watching over one another","life.items.1.p1":"Course discussion, case sharing and response","life.items.1.p2":"Online fellowship across regions","life.items.2.title":"Ministry Practice","life.items.2.body":"Take learning into church, family, workplace and mission.","life.items.2.p0":"Serving roles alongside local churches","life.items.2.p1":"Practice in preaching, discipleship and visitation","life.items.2.p2":"On-site intensives and practicum weeks in Chiang Mai","life.items.3.title":"Worship & Devotion","life.items.3.body":"Rooted in worship and prayer — life before ministry.","life.items.3.p0":"Steady rhythms of devotion and prayer","life.items.3.p1":"Participation in worship and service","life.items.3.p2":"Godliness and character formed in community",
  "life.rhythm.title":"Weekly Rhythm","life.rhythm.0":"Online courses and reading","life.rhythm.1":"Group discussion and response","life.rhythm.2":"Discipleship and mentoring time","life.rhythm.3":"Church ministry and everyday practice",
  "resources.title":"Resources","resources.searchLabel":"Search resources","resources.searchPlaceholder":"Search resources…","resources.count":"{n} resources found","resources.items.0":"New Student Handbook","resources.items.1":"B.Th Curriculum Guide","resources.items.2":"Tuition & Learning Support","resources.items.3":"Online Application (Fast Track)","resources.items.4":"Application Form (Full Word Version)","resources.items.5":"Upload Your Completed Application","actions.upload":"Upload ↑","upload.name":"Name","upload.contact":"Contact (Email / WeChat / Phone)","upload.file":"Choose your completed form (Word or PDF)","upload.submit":"Upload & Submit","upload.note":"Your file goes directly to the admissions team's inbox; a confirmation page opens after submission.",
  "courseCards.25.title":"Systematic Theology II","courseCards.25.body":"Christology, soteriology and further core doctrines.","courseCards.26.title":"Systematic Theology III","courseCards.26.body":"Ecclesiology, eschatology and doctrinal integration.","courseCards.27.title":"Culture of Israel","courseCards.27.body":"Israel's history and culture behind the biblical text.","courseCards.28.title":"World Church History","courseCards.28.body":"Two millennia of the church's journey and heritage.","courseCards.29.title":"Chinese Church History","courseCards.29.body":"The gospel's arrival and the church's growth in China.","courseCards.30.title":"Biblical Greek","courseCards.30.body":"Foundations of NT Greek for reading the original text.","courseCards.31.title":"Basic Hebrew","courseCards.31.body":"Introductory elements of OT Hebrew.","courseCards.32.title":"New Believer Teaching Materials","courseCards.32.body":"Preparing and using materials for new believers.","courseCards.33.title":"Homiletics","courseCards.33.body":"From exegesis to sermon design: faithful, clear preaching.","courseCards.34.title":"Preaching Practicum I","courseCards.34.body":"Practice preaching fundamentals at the pulpit.","courseCards.35.title":"Preaching Practicum II","courseCards.35.body":"Advanced practicum and feedback to shape your voice.","courseCards.36.title":"Worship Leading","courseCards.36.body":"Principles and skills for leading congregational worship.","courseCards.37.title":"One-Day Inner Healing","courseCards.37.body":"An intensive one-day inner-healing practicum.","courseCards.38.title":"Computer Applications","courseCards.38.body":"Documents, slides and online tools for ministry.","courseCards.39.title":"Genesis","courseCards.39.body":"Creation, fall and the beginning of redemption.","courseCards.40.title":"Leviticus","courseCards.40.body":"Holiness and worship through sacrifices and feasts.","courseCards.41.title":"Christian Ethics","courseCards.41.body":"Responding to today's ethical issues biblically.","courseCards.42.title":"Children's Education","courseCards.42.body":"Vision and practice of children's ministry.","courseCards.43.title":"Comparative Religion","courseCards.43.body":"Major religions and the uniqueness of the gospel.","courseCards.44.title":"Understanding Islam","courseCards.44.body":"Understanding Islam and reaching Muslims.","courseCards.45.title":"Three-Person Church","courseCards.45.body":"Church planting starting from the smallest unit.","courseCards.46.title":"Bible Geography","courseCards.46.body":"Reading biblical narrative through its geography.","courseCards.47.title":"Worldview Studies","courseCards.47.body":"Discerning worldviews with a biblical lens.","courseCards.48.title":"Ministry Case Studies","courseCards.48.body":"Lessons and warnings from real ministry cases.","courseCards.49.title":"Leadership","courseCards.49.body":"Character and practice of spiritual leadership.","courseCards.50.title":"Cults in China","courseCards.50.body":"Discerning cults and holding fast sound faith.","courseCards.51.title":"Power Prayer","courseCards.51.body":"A prayer life and ministry marked by power.","courses.filters.history":"History","courses.filters.language":"Language","courses.filters.elective":"Electives","training.0":"Bible read-through (three times)","training.1":"Scripture memorization","training.2":"Family worship training","training.3":"Relationship training","training.4":"Stewardship training","training.5":"Compose 100 sermons (600+ pages)","training.6":"Daily one-hour prayer (1 credit / 100 days)","training.7":"Evangelism (1 credit per 5 people)","training.8":"Q.T devotions (1 credit / 100 days)","training.9":"Morning prayer (1 credit / 100 days)","training.10":"Church planting","training.title":"Spiritual Training & Graduation Requirements","training.note":"The G.Dip / M.Div track requires 90 credits to graduate; the training items below are verified and credited by the school.","training.unit":"credits",
  "verse.courses":"“Do your best to present yourself to God as one approved, a worker who does not need to be ashamed and who correctly handles the word of truth.”","verse.coursesRef":"— 2 Timothy 2:15","verse.adm":"“Come, follow me, and I will send you out to fish for people.”","verse.admRef":"— Matthew 4:19","verse.life":"“As iron sharpens iron, so one person sharpens another.”","verse.lifeRef":"— Proverbs 27:17","verse.digital":"“Your word is a lamp for my feet, a light on my path.”","verse.digitalRef":"— Psalm 119:105","verse.res":"“All Scripture is God-breathed and is useful for teaching, rebuking, correcting and training in righteousness.”","verse.resRef":"— 2 Timothy 3:16",
  "footer.desc":"Rooted in Scripture and prayer, equipping workers for the harvest fields of Asia. Our Chiang Mai campus and online classrooms serve the Chinese church and cross-cultural mission.","footer.c1":"Seminary","footer.c2":"Study","footer.c3":"Get Started",
  "faq.title":"Frequently Asked Questions","faq.items.0.q":"Can I apply without prior theological study?","faq.items.0.a":"Yes. We value willingness to learn, consistency and commitment to serious formation.","faq.items.1.q":"Are all classes online?","faq.items.1.a":"Learning is flexible: online coursework is combined with encouraged in-person discipleship, practice and community in Chiang Mai.","faq.items.2.q":"Who manages student status and degree completion?","faq.items.2.a":"Official student status is reviewed and established through AMAS according to school policies.","faq.items.3.q":"How do I begin?","faq.items.3.a":"Click Apply, submit basic information and your motivation, then admissions will contact you with next steps.",
  "giving.cta":"How to Take Part","giving.ctaNote":"Details are shared personally, one to one, by our team.",
  "giving.title":"Giving & Support","giving.verse":"“Each of you should give what you have decided in your heart to give, not reluctantly or under compulsion, for God loves a cheerful giver.”","giving.verseRef":"— 2 Corinthians 9:7","giving.desc":"Theological education is a shared ministry. Your giving helps committed students finish their training, and keeps the teaching and mission work moving forward.","giving.d1":"Student Aid","giving.d1b":"Help students in financial hardship complete their training","giving.d2":"Teaching Ministry","giving.d2b":"Support the faculty and curriculum development","giving.d3":"Missionary Training","giving.d3b":"Support workers preparing to be sent","giving.ok":"Received — may the Lord remember your gift!","giving.fail":"Failed to send. Please try again or contact us directly.","giving.note":"Giving is entirely voluntary and is used for student aid, teaching and mission; you are welcome to ask how gifts are used at any time.","faq.items.4.q":"How can I support AMAS?","faq.items.4.a":"Pray for us, give toward student aid, teaching or missionary training (see the Giving section), or simply introduce AMAS to someone who should know about it.",
  "promo.tab":"Admissions 2026 Open","promo.title":"B.Th Class of 2026 — Now Enrolling","promo.desc":"Online + on-site in Chiang Mai · pay per course · starts September 2026. Curious? Our admissions assistant is here to help.","promo.ask":"Ask Now","promo.apply":"Apply","admissions.countdown":"Classes begin September 2026 · Now enrolling","admissions.started":"Classes have begun — ask about the next intake","actions.copy":"Copy","toast.copied":"Copied","faq.ask.title":"Still have questions?","faq.ask.desc":"Our AI assistant is available anytime — or leave a message for the admissions team and we will reply soon.","faq.ask.ai":"Ask the AI assistant","faq.ask.leave":"Leave a message",
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
  "application.programs.bth":"Bachelor of Theology B.Th (2026 first intake)","application.programs.gdip":"Master of Ministry Studies G.Dip","application.programs.mdiv":"Master of Divinity M.DIV","application.programs.dmin":"Doctor of Ministry / Missiology D.MIN / D.MISS","application.programs.pastor":"Pastoral Continuing Education","application.programs.preaching":"School of Preaching","application.programs.missionary":"Missionary Training",
  "application.modes.online":"Mainly online","application.modes.onsite":"Mainly in-person","application.modes.hybrid":"Online + in-person",
  "application.consent":"I confirm the information above is accurate and agree to be contacted regarding admissions.","application.back":"Back","application.next":"Next","application.submit":"Submit Application",
  "application.okDemo":"Application saved locally for demo. Connect a backend/database for production.","application.ok":"Application sent. Our admissions team will contact you soon.","application.error":"Submission failed: network or server error. Please retry, or reach us with the contact details below.",
  "application.stepOf":"Step {n} of 4",
  "review.fullName":"Name (Chinese)","review.englishName":"Name (English)","review.gender":"Gender","review.birth":"Date of Birth","review.nationality":"Nationality","review.language":"Language","review.phone":"Mobile","review.email":"Email / QQ / WeChat","review.location":"City / Country","review.church":"Church","review.churchType":"Church Type","review.conversionDate":"Conversion","review.baptismDate":"Baptism","review.role":"Ministry / Role","review.referrer":"Referrer","review.program":"Program","review.eduLevel":"Highest Education","review.eduSchool":"School","review.mode":"Study Mode","review.gifts":"Gifts","review.motivation":"Vision & Testimony"
 },
 ko: {
  "chat.open":"온라인 상담 열기","chat.title":"입학 상담 도우미","chat.subtitle":"즉시 답변 · 입학처에 메시지 남기기 가능","chat.placeholder":"질문을 입력하세요…","chat.send":"보내기","chat.note":"자동 응답은 본 사이트 정보를 기반으로 하며, 메시지는 입학 담당자에게 전달됩니다.",
  "chat.greeting":"평안하세요! 아시아선교신학교(AMAS) 입학 상담 도우미입니다. 지원 방법, 등록금, 과정 등에 대해 답해 드리며, 입학 담당자에게 직접 메시지를 남기실 수도 있습니다. 무엇이 궁금하신가요?","chat.fallback":"이 질문에는 정확한 답을 드리기 어렵습니다. 입학 담당자에게 메시지를 남겨 주시면 빠르게 회신해 드리겠습니다.",
  "chat.chips.apply":"어떻게 지원하나요?","chat.chips.tuition":"등록금은 얼마인가요?","chat.chips.courses":"어떤 과목이 있나요?","chat.chips.mode":"수업은 어떻게 진행되나요?","chat.chips.leave":"입학처에 메시지 남기기",
  "chat.chips.human":"상담원 연결","chat.human.intro":"네, 아래 방법으로 입학 담당자에게 직접 연락하실 수 있습니다(보통 당일 회신):","chat.human.wechat":"WeChat {id} · 눌러서 복사","chat.human.line":"Line {id} · 눌러서 복사","chat.human.note":"친구 추가 시 \u201cAMAS 문의\u201d라고 남겨 주세요. 연락이 어려우시면 여기에 메시지를 남기셔도 됩니다.",
  "chat.kb.apply":"「입학 지원」을 눌러 온라인 지원서를 작성하세요(약 3분). 제출 후 입학 담당자가 연락드려 다음 단계를 안내합니다. 자료실에서 Word 지원서 전체 양식을 내려받을 수도 있습니다.",
  "chat.kb.tuition":"등록금은 과목별 수강·과목별 납부 방식입니다. 구체적인 금액은 입학 담당자에게 직접 문의해 주세요. 경제적으로 어려운 학생은 감면·분납 등 학업 지원을 신청할 수 있습니다.","chat.kb.tuitionBtn":"등록금과 지원 안내",
  "chat.kb.courses":"공식 커리큘럼으로 52개 과목(선택 13과목 포함)과 영성 훈련 항목을 개설하며, 석사 과정(G.Dip / M.Div) 졸업 학점은 90학점입니다. 성경·신학·역사·실천·성경 언어를 아우릅니다.","chat.kb.coursesBtn":"과목 살펴보기",
  "chat.kb.programs":"학위 과정은 학점제·과목별 수강: 신학사(B.Th, 90학점)·목회연구석사(G.Dip, 90)·목회학석사(M.Div, 90)·목회학/선교학박사(D.Min/D.Miss, 48). 자격·훈련 과정: 평신도 지도자 과정, 목회 훈련 디플로마, 목회자 연수, 설교학교, 선교사 훈련. 2026학년도 B.Th 모집 중, 9월 개강.","chat.kb.programsBtn":"과정 안내 보기",
  "chat.kb.mode":"온라인 + 오프라인 유연 학습: 온라인 수업을 중심으로 치앙마이 현장 제자훈련과 실습 참여를 권장합니다. 2026학년도 B.Th는 2026년 9월 개강합니다.",
  "chat.kb.contact":"다음 연락처로 문의하실 수 있습니다:","chat.kb.contactEmpty":"연락처는 곧 공개됩니다. 지금은 이곳에 메시지를 남기시거나 페이지 하단의 문의 양식을 이용해 주세요.",
  "chat.kb.location":"본교 교육센터는 태국 치앙마이(Chiang Mai)에 있으며, 온라인 학습도 함께 제공합니다.",
  "chat.kb.video":"학교 소개 영상을 준비했습니다. 클릭하여 시청하세요.",
  "chat.leave.askName":"네, 전달해 드리겠습니다. 성함이 어떻게 되시나요?","chat.leave.askContact":"연락처를 남겨 주세요(위챗 / 이메일 / 전화 모두 가능):","chat.leave.askContent":"입학 담당자에게 전할 내용을 입력해 주세요:",
  "chat.leave.done":"메시지가 전송되었습니다. 입학 담당자가 곧 회신드리겠습니다. 다른 질문이 있으신가요?","chat.leave.doneDemo":"메시지가 저장되었습니다(현재 데모 모드). 다른 질문이 있으신가요?","chat.leave.fail":"죄송합니다. 전송에 실패했습니다. 잠시 후 다시 시도하시거나 페이지 하단의 문의 양식을 이용해 주세요.",
  "brand.sub":"아시아선교신학교 · 치앙마이 교육센터","brand.zoom":"학교 문장 크게 보기","brand.sealSub":"AMAS 아시아선교신학교 · 태국",
  "announce.brand":"AMAS 아시아선교신학교 · 치앙마이 교육센터","announce.verse":"“내가 누구를 보내며 누가 우리를 위하여 갈꼬” “내가 여기 있나이다 나를 보내소서” — 이사야 6:8","announce.moto":"오늘의 제자를 세우고 · 내일의 사역자를 보냅니다","announce.hot":"2026학년도 신학사 B.Th 신입생 모집","announce.link":"모집 안내 보기 →",
  "nav.home":"홈","nav.about":"학교 소개","nav.courses":"교육 과정","nav.admissions":"입학 안내","nav.tuition":"등록금·지원","nav.life":"학교 생활","nav.resources":"자료실","nav.contact":"문의하기",
  "actions.apply":"입학 지원","actions.login":"로그인","actions.video":"소개 영상 보기","actions.applyNow":"바로 지원하기","actions.download":"다운로드 ↓","actions.view":"보기 →","actions.fill":"작성 →","actions.skip":"본문 바로가기","actions.backToTop":"↑ 맨 위로","actions.close":"닫기","actions.sending":"제출 중…",
  "a11y.themeToNight":"야간 모드로 전환","a11y.themeToDay":"주간 모드로 전환","a11y.themeNight":"야간 모드","a11y.themeDay":"주간 모드","a11y.langSwitch":"언어 전환(현재 한국어)","a11y.openMenu":"메뉴 열기","a11y.closeMenu":"메뉴 닫기",
  "toast.themeNight":"야간 모드로 전환되었습니다","toast.themeDay":"주간 모드로 전환되었습니다","toast.applied":"지원서가 전송되었습니다","toast.appliedDemo":"지원서가 제출되었습니다(데모)","toast.inquiry":"문의가 전송되었습니다","toast.inquiryDemo":"문의가 제출되었습니다(데모)","toast.failed":"제출 실패. 잠시 후 다시 시도해 주세요","toast.downloaded":"샘플 파일이 다운로드되었습니다",
  "meta.credits":"{n}학점","hero.title":"아시아선교신학교","hero.sub":"ASIA MISSIONARY ASSOCIATION SEMINARY","hero.verse":"그러므로 너희는 가서 모든 민족을 제자로 삼으라.","hero.verseRef":"— 마태복음 28:19",
  "hero.ai.title":"맞춤 신학 · 3분 만에 나의 신앙 성장 상태 보기","hero.ai.sub":"10문항 · 5가지 초기 지표 · 다음 한 걸음 · 전체 Christian Profile은 앱에서","hero.ai.go":"바로 탐색 →",
  "herometa.program":"과정","herometa.programVal":"신학사 B.Th","herometa.startVal":"2026년 9월","herometa.start":"2026학년도 개강","herometa.mode":"학습","herometa.modeVal":"온라인 + 오프라인",
  "accred.more":"인증 상세 보기 →","accred.title":"학술 인증","accred.intro":"AMAS의 다음 학위 과정은 Asia Theological Association(ATA)의 인증 평가를 통과했습니다.","accred.bthName":"신학사 Bachelor of Theology (B.Th.)","accred.mdivName":"목회학석사 Master of Divinity (M.Div.)","accred.dminName":"목회학박사 Doctor of Ministry (D.Min.)","accred.bthNote":"Asia Theological Association (ATA) 인증","accred.note":"ATA 인증은 위에 명시된 학위 과정에 적용되며, 인증 범위와 유효 기간은 ATA가 발급한 인증 문서를 기준으로 합니다.",
  "actions.consult":"입학 상담","actions.applyBth":"신학사 B.Th 지원",
  "band.status":"본교 심사를 거쳐 정식 학적 등록","band.mode":"온라인 수업 + 치앙마이 현장 훈련","band.adm":"2026학년도 신학사 B.Th 모집",
  "admissions.facts.startLabel":"개강","admissions.facts.startValue":"2026년 9월","admissions.facts.feeLabel":"등록금","admissions.facts.feeValue":"입학처에 문의해 주세요","admissions.facts.modeLabel":"방식","admissions.facts.modeValue":"온라인 + 오프라인","admissions.facts.statusLabel":"학적","admissions.facts.statusValue":"본교 심사 후 등록",
  "admissions.consultBtn":"먼저 상담하기 (30초)","admissions.applyBtn":"정식 지원",
  "admissions.path.title1":"AMAS가 처음이신가요?","admissions.path.title2":"가벼운 상담부터 시작하세요.","admissions.path.s1":"빠른 상담","admissions.path.s1d":"이름 + 연락처 + 도시 + 궁금한 점","admissions.path.s2":"입학 담당자 상담","admissions.path.s2d":"과정·학적·일정·적합성 확인","admissions.path.s3":"정식 지원","admissions.path.s3d":"신앙 및 사역 정보를 포함한 지원서 작성",
  "about.title":"AMAS 아시아선교신학교<br>성경에 뿌리내리고 · 세계를 향하여","about.body":"우리는 성경 진리를 기초로 타문화 비전과 실천 훈련을 결합하여, 학생들을 신실한 전도자·목회자·선교사로 세우고, 교회와 세상 속에서 복음을 살아내며 하나님 나라를 증거하도록 돕습니다.","about.link":"우리의 비전과 사명 보기",
  "pillars.bible.title":"성경 중심","pillars.bible.body":"성경의 권위를 붙들고 진리의 기초를 깊게 하여 견고한 신학적 사고와 영적 통찰을 기릅니다.",
  "pillars.practice.title":"실천 지향","pillars.practice.body":"이론과 실천을 함께 강조하며, 강의실과 사역 현장을 연결하여 실제로 쓰이는 섬김의 능력을 갖춥니다.",
  "pillars.mission.title":"선교 비전","pillars.mission.body":"온 세계를 바라보며 타문화 사역을 준비하고 대위임령의 부르심에 응답합니다.",
  "pillars.life.title":"영성 훈련","pillars.life.body":"영적 생명과 인격의 성숙을 중시하여 하나님의 마음에 합한 일꾼으로 자랍니다.",
  "stats.courses":"공식 과목 · 선택 13","stats.flex.title":"유연한 학습","stats.flex.body":"온·오프라인 병행 학습","stats.global.title":"글로벌 시야","stats.global.body":"타문화 학습과 선교 네트워크","stats.team.title":"목회자 교수진","stats.team.body":"경륜 있는 목회자·교사의 동행","stats.year":"2026학년도 신학사 B.Th 모집 시작",
  "mission.aria":"비전과 사명","mission.title":"과정을 마치는 것이 아니라<br>섬김을 위해 준비됩니다.","mission.desc":"신학 교육을 실제 교회·가정·일터·선교 현장으로 되돌려 지식과 삶과 행동이 서로 연결되게 합니다.",
  "mission.vision.0":"하나님의 말씀과 성령의 능력으로 준비된 목회자와 선교사를 세운다.","mission.vision.1":"아시아 각국에 말씀과 성령의 능력으로 준비된 선교 센터를 세운다.","mission.vision.2":"아시아 각국에 성경과 실천을 중시하는 신학교를 세워 현지 목회자와 일꾼을 양성한다.",
  "mission.items.0.title":"진리에 뿌리내림","mission.items.0.body":"신뢰할 수 있는 성경 해석과 신학의 기초를 세웁니다.","mission.items.1.title":"생명의 빚어짐","mission.items.1.body":"영성 훈련·공동체 관계·인격 성장이 중심입니다.","mission.items.2.title":"실천 훈련","mission.items.2.body":"배운 것을 설교·목양·제자훈련·섬김의 능력으로 전환합니다.","mission.items.3.title":"사명에 응답","mission.items.3.body":"담대히 복음을 전하며 타문화 선교의 시야와 능력을 갖춥니다.",
  "courses.title":"교육 과정","courses.desc":"학교 공식 커리큘럼에 따라 필수·선택 과목과 영성 훈련을 개설하며, 성경·조직·역사·실천신학과 성경 언어를 아우릅니다.","courses.filterGroup":"과목 필터","courses.filters.all":"전체","courses.filters.bible":"성경","courses.filters.theology":"신학","courses.filters.ministry":"사역 실천","courses.filters.mission":"선교","courses.filters.formation":"영성 훈련","courses.count":"{n}개 과목 표시 중","courses.more":"전체 과목 펼치기 (외 {n}과목)","courses.less":"과목 목록 접기",
  "courseCards.0.title":"성경개관","courseCards.0.body":"성경 전체의 구조와 흐름, 구속사의 큰 줄기를 조망합니다.","courseCards.1.title":"마태복음","courseCards.1.body":"천국 복음을 연구하며 왕이신 그리스도와 제자의 길을 배웁니다.","courseCards.2.title":"요한복음","courseCards.2.body":"예수님의 인격과 사역을 알고 그 이름을 믿어 생명을 얻습니다.","courseCards.3.title":"사도행전","courseCards.3.body":"초대교회의 발자취를 따라 예루살렘에서 땅끝까지 이르는 복음을 봅니다.","courseCards.4.title":"로마서","courseCards.4.body":"이신칭의의 복음 대강령과 새 생명의 길을 체계적으로 연구합니다.","courseCards.5.title":"고린도전서","courseCards.5.body":"교회 질서·십자가 신학·공동체 세움을 중심으로 서신을 연구합니다.","courseCards.6.title":"고린도후서","courseCards.6.body":"연약함 속에서 하나님의 위로와 능력, 사역자의 직분을 배웁니다.","courseCards.7.title":"에베소서","courseCards.7.body":"그리스도의 몸 된 교회의 비밀과 그 안의 새 생활을 배웁니다.","courseCards.8.title":"히브리서","courseCards.8.body":"더 좋은 대제사장이신 그리스도를 바라보며 소망을 굳게 붙듭니다.","courseCards.9.title":"요한계시록","courseCards.9.body":"묵시문학을 통해 종말의 소망과 교회의 승리를 배웁니다.",
  "courseCards.10.title":"조직신학 1","courseCards.10.body":"평신도와 초급 과정 학생을 위한 교리 개관으로 신앙의 틀을 세웁니다.","courseCards.11.title":"상황화 신학","courseCards.11.body":"아시아의 상황 속에서 성경에 충실하게 사고하고 표현하며 실천합니다.","courseCards.12.title":"전도","courseCards.12.body":"복음의 메시지·방법·후속 양육의 길을 익힙니다.","courseCards.13.title":"목회상담","courseCards.13.body":"경청·상담·영적 동행의 기본기를 배웁니다.","courseCards.14.title":"소그룹","courseCards.14.body":"건강한 소그룹을 세우고 인도하며 배가시킵니다.","courseCards.15.title":"새신자 사역","courseCards.15.body":"체계적인 교재로 새신자가 신앙에 뿌리내리고 교회에 정착하도록 돕습니다.","courseCards.16.title":"교회 운영","courseCards.16.body":"치리·동역·사역 계획까지 교회 운영의 실제를 배웁니다.","courseCards.17.title":"예배학","courseCards.17.body":"예배의 성경적 의미와 예배 순서의 구성을 배웁니다.","courseCards.18.title":"내적 치유","courseCards.18.body":"진리와 성령 안에서 마음의 상처가 치유되고 자유를 얻습니다.","courseCards.19.title":"질병 치유","courseCards.19.body":"성경의 기초 위에서 치유 기도의 원리와 실천을 배웁니다.","courseCards.20.title":"말씀 치유","courseCards.20.body":"하나님의 말씀을 선포하고 중보하며 병중에 있는 이를 돌봅니다.","courseCards.21.title":"영적 전쟁","courseCards.21.body":"영적 전쟁의 성경적 원리를 알고 하나님의 전신갑주를 입습니다.","courseCards.22.title":"그리스도인의 생활","courseCards.22.body":"일상에서 믿음과 경건과 증인의 삶을 훈련합니다.","courseCards.23.title":"평신도 양육(제자)","courseCards.23.body":"제자로서 그리스도를 따르며 견고한 삶의 리듬을 세웁니다.","courseCards.24.title":"평신도 양육(확신)","courseCards.24.body":"구원의 확신을 세우고 견고하며 소망 있는 신앙의 기초 위에 삽니다.",
  "programs.title":"교육 프로그램","programs.desc":"학점제 · 과목별 수강·납부: 자격 과정부터 박사 연구까지, 필요 학점을 채우면 졸업합니다. 2026학년도 B.Th 모집 중이며, 나머지 과정도 개설 중입니다. 자세한 내용은 문의해 주세요.",
  "programs.degree.title":"학위 과정","programs.degree.sub":"학점제로 과목별 이수, 규정 학점을 채우면 졸업. 학적은 AMAS 본교 심사로 등록.","programs.equip.title":"자격·훈련 과정","programs.equip.sub":"현직 목회자와 평신도를 위한 단기 훈련",
  "programs.items.laycert.badge":"수료","programs.items.laycert.name":"평신도 지도자 과정","programs.items.laycert.desc":"36학점 · 3개월마다 10일 집중 과정 · 학점 이수 시 수료","programs.items.pdip.badge":"디플로마","programs.items.pdip.name":"목회 훈련 디플로마","programs.items.pdip.desc":"60학점 · 온라인 과목별 수강 · 수료증 발급","application.programs.laycert":"평신도 지도자 과정(수료)","application.programs.pdip":"목회 훈련 디플로마",
  "programs.items.bth.name":"신학사","programs.items.bth.desc":"2026학년도 모집 · 2026년 9월 개강 · 90학점 · 과목별 수강, 온라인 + 오프라인",
  "programs.items.gdip.name":"목회연구석사 (G.Dip)","programs.items.gdip.desc":"90학점 · 과목별 수강 · 추가 이수 시 M.Div 연계",
  "programs.items.mdiv.name":"목회학석사","programs.items.mdiv.desc":"90학점 · 과목별 수강 · 전임 사역을 위한 신학·목회 훈련",
  "programs.items.dmin.name":"목회학박사 / 선교학박사","programs.items.dmin.desc":"D.Min / D.Miss · 48학점(논문 포함) · 학점제 연구와 실천",
  "programs.items.pastor.badge":"연수","programs.items.pastor.name":"목회자 연수","programs.items.pastor.desc":"현직 목회자의 지속적 재충전과 갱신",
  "programs.items.preaching.badge":"설교","programs.items.preaching.name":"설교학교","programs.items.preaching.desc":"본문 해석부터 선포까지 집중 훈련",
  "programs.items.missionary.badge":"선교","programs.items.missionary.name":"선교사 훈련","programs.items.missionary.desc":"타문화 사역의 소명 분별과 파송 준비",
  "programs.note":"각 과정의 개설 시기·수학 연한·지원 자격은 「입학 지원」 또는 연락처를 통해 입학 담당자에게 문의해 주세요.",
  "nav.programs":"교육 프로그램",
  "digital.title":"디지털 캠퍼스","digital.desc":"본교는 과정·자료·공동체를 하나의 입구로 연결하는 학습 플랫폼을 구축하고 있습니다.",
  "digital.items.0.title":"원격 강의실","digital.items.0.body":"수강 중인 과목·실시간 강의·다시보기를 한곳에 모아 모바일에서도 이어서 학습합니다.",
  "digital.items.1.title":"도서관 자료","digital.items.1.body":"강의안·오디오·연구 자료가 도서관과 과목 자료 페이지에 함께 제공됩니다.",
  "digital.items.2.title":"동문 커뮤니티","digital.items.2.body":"토론·중보기도·멘토 피드백·음성방으로 학습과 공동체가 연결됩니다.",
  "digital.ai.cta":"3분 빠른 탐색 · 미리 체험","digital.ai.ctaNote":"전체 Christian Profile(12가지 사역 성향, 4개 영역 별도 측정)은 앱에서 만들어집니다.",
  "digital.app.web":"웹 앱 열기",
  "digital.ai.title":"맞춤 신학 · AI 개인 맞춤 훈련","digital.ai.quote":"\u201c모든 사람이 같은 과목에서 시작할 필요는 없습니다.\u201d","digital.ai.body":"AI가 당신의 신앙·성경·신학·삶·사역 상황을 대화로 평가하여 신학 성장 프로필을 만들고, 개인 맞춤 훈련 경로를 설계합니다. 학습 중에도 계속 평가하고 조정하여 실제 사역으로 파송될 때까지 함께합니다.","digital.ai.f0":"당신을 알기","digital.ai.f1":"평가","digital.ai.f2":"성장 프로필","digital.ai.f3":"맞춤 경로","digital.ai.f4":"지속 조정","digital.items.3.title":"강의 맛보기","digital.items.3.body":"엄선된 무료 공개 강의를 먼저 듣고 등록을 결정하세요.","digital.items.4.title":"학습 경로","digital.items.4.body":"수료 과정부터 박사 연구까지 단계별 경로를 한눈에.","digital.items.5.title":"온라인 상담","digital.items.5.body":"공지·질의응답·입학 상담을 언제든 손안에서.",
  "digital.note.label":"개발 중: ","digital.note.body":"학습 앱은 내부 테스트 중이며 정식 출시 후 이곳에서 다운로드할 수 있습니다.",
  "admissions.title":"2026학년도 신학사 B.Th 모집","admissions.desc":"성실히 훈련받고 꾸준히 성장하며 섬김에 참여하려는 이들을 위한 유연하고 실천 중심적인 신학 교육의 길을 제공합니다.","tuition.title":"등록금과 학업 지원","tuition.motto":"훈련받기를 원하는 모든 이에게 계속 배울 길이 열려 있기를.","tuition.mode":"과목별 수강 · 과목별 납부",
  "tuition.p1":"AMAS는 과목별 수강·과목별 납부 방식을 채택합니다. 학생은 자신의 진도에 따라 과목을 선택하며 학기·학년 전체 비용을 한 번에 부담할 필요가 없어 학습 계획이 유연해지고 일시적 경제 부담이 줄어듭니다. 구체적인 과목 비용은 입학 담당자에게 직접 문의해 주세요.",
  "tuition.p2":"신학 훈련에는 학생의 성실한 헌신과 함께 학교·교수·사역팀이 감당하는 교육 비용이 필요합니다. 따라서 등록금을 성실히 납부하는 것은 배움에 대한 헌신이자 교육 사역을 향한 후원입니다.",
  "tuition.v1":"“할 마음만 있으면 있는 대로 받으실 터이요 없는 것은 받지 아니하시리라.”","tuition.v1ref":"—— 고린도후서 8:12",
  "tuition.p3":"그러므로 경제적 어려움이 신학 훈련의 장벽이 되어서는 안 됩니다. 실제로 어려움이 있으나 성실히 배우기를 원하는 학생은 입학처나 교무처에 사정을 알려 주시면, 학교가 개별 상황에 따라 등록금 감면·분납·기타 학업 지원을 제공합니다.",
  "tuition.p4":"우리의 원칙은 단순히 “등록금을 낮추는 것”이 아니라, 진심으로 배우기를 원하는 모든 이가 계속 훈련받을 수 있는 길을 찾도록 돕는 것입니다.",
  "tuition.v2":"“말씀을 가르침을 받는 자는 가르치는 자와 모든 좋은 것을 함께 하라.”","tuition.v2ref":"—— 갈라디아서 6:6",
  "tuition.p5":"AMAS는 건강한 배움의 문화를 소망합니다. 여력이 있는 학생은 등록금을 성실히 부담하고, 어려운 학생은 도움을 받으며, 여유가 있는 이는 <a href=\"#giving\">후원</a>으로 다른 학생의 훈련을 돕습니다.",
  "tuition.ctaFee":"과목 비용 문의","tuition.ctaAid":"학업 지원 신청",
  "tuition.pr.title":"등록금 원칙","tuition.pr.0":"등록금은 과목 단위로 산정되며, 금액은 입학 담당자에게 문의","tuition.pr.1":"과목별 납부, 연간 일시납 요구 없음","tuition.pr.2":"경제적 어려움이 있는 경우 개별 심사와 학업 지원 신청 가능","tuition.pr.3":"경제적 이유만으로 진지하게 훈련을 구하는 학생을 거절하지 않음","tuition.pr.4":"감면·분납·지원 방식은 학교와 개별 상담으로 결정",
  "life.title":"배움은 홀로 이루어지지 않습니다.","life.desc":"강의·제자훈련·소그룹·교회 섬김과 실제 삶이 함께 신학 교육을 이룹니다.","life.items.0.title":"멘토 동행","life.items.0.body":"수업 밖에서도 삶의 동행과 방향 분별을 중시합니다.","life.items.0.p0":"정기적인 일대일 동행과 중보기도","life.items.0.p1":"학업 방향과 사역 소명의 분별","life.items.0.p2":"경륜 있는 목회자와 동행하는 영적 네트워크","life.items.1.title":"소그룹 학습","life.items.1.body":"토론·사례·상호 피드백으로 배움을 깊게 합니다.","life.items.1.p0":"고정 학습 소그룹에서 서로 돌봄","life.items.1.p1":"과목 토론·사례 나눔·상호 피드백","life.items.1.p2":"지역을 넘는 온라인 교제 생활","life.items.2.title":"실천 섬김","life.items.2.body":"배운 것을 교회·가정·일터·선교 현장으로 가져갑니다.","life.items.2.p0":"지역 교회와 동역하는 섬김의 자리","life.items.2.p1":"전도·제자훈련·심방 등 실천 배치","life.items.2.p2":"치앙마이 현장 집중 훈련과 실습 주간","life.items.3.title":"예배와 경건","life.items.3.body":"예배와 기도에 뿌리내려, 사역보다 생명이 먼저입니다.","life.items.3.p0":"규칙적인 경건과 기도 훈련","life.items.3.p1":"예배 모임과 예배 섬김 참여","life.items.3.p2":"공동체 안에서 경건과 인격을 세움",
  "life.rhythm.title":"주간 학습 리듬","life.rhythm.0":"온라인 수업과 읽기 과제","life.rhythm.1":"소그룹 토론과 상호 피드백","life.rhythm.2":"제자훈련과 멘토 시간","life.rhythm.3":"교회 섬김과 삶의 실천",
  "resources.title":"자료실","resources.searchLabel":"자료 검색","resources.searchPlaceholder":"자료 검색…","resources.count":"{n}개 자료 검색됨","resources.items.0":"신입생 안내서","resources.items.1":"B.Th 과목 목록","resources.items.2":"등록금과 학업 지원","resources.items.3":"온라인 지원(빠른 통로)","resources.items.4":"입학지원서(전체 Word판)","resources.items.5":"작성한 지원서 업로드","actions.upload":"업로드 ↑","upload.name":"이름","upload.contact":"연락처(이메일 / 위챗 / 전화)","upload.file":"작성한 지원서 선택(Word 또는 PDF)","upload.submit":"업로드 및 제출","upload.note":"자료는 입학 담당자 이메일로 바로 전송되며, 제출 후 새 페이지에 확인이 표시됩니다.",
  "courseCards.25.title":"조직신학 2","courseCards.25.body":"기독론·구원론 등 핵심 교리를 이어서 배웁니다.","courseCards.26.title":"조직신학 3","courseCards.26.body":"교회론·종말론 등 교리의 통합적 구성.","courseCards.27.title":"이스라엘 문화","courseCards.27.body":"성경 배경이 되는 이스라엘 역사와 문화.","courseCards.28.title":"세계교회사","courseCards.28.body":"2천 년 교회의 여정과 영적 유산.","courseCards.29.title":"중국교회사","courseCards.29.body":"복음의 중국 전래와 교회 성장의 길.","courseCards.30.title":"헬라어","courseCards.30.body":"신약 헬라어 기초로 원문을 읽습니다.","courseCards.31.title":"히브리어 기초","courseCards.31.body":"구약 히브리어의 입문 요소.","courseCards.32.title":"새신자 교육교재","courseCards.32.body":"새신자 양육 교재의 작성과 활용.","courseCards.33.title":"설교학","courseCards.33.body":"석의부터 메시지 구성까지 신실한 설교를 배웁니다.","courseCards.34.title":"설교실습 1","courseCards.34.body":"실제 강단 훈련으로 설교 기본기를 다집니다.","courseCards.35.title":"설교실습 2","courseCards.35.body":"심화 설교 실습과 강평으로 자기 설교를 세웁니다.","courseCards.36.title":"찬양 인도법","courseCards.36.body":"회중 찬양 인도의 원리와 실제.","courseCards.37.title":"1일 내적치유","courseCards.37.body":"하루 집중 내적치유 실습 과정.","courseCards.38.title":"컴퓨터 활용","courseCards.38.body":"사역에 필요한 문서·발표·인터넷 도구 활용.","courseCards.39.title":"창세기","courseCards.39.body":"창조와 타락, 구속의 시작을 배웁니다.","courseCards.40.title":"레위기","courseCards.40.body":"제사와 절기로 거룩과 예배의 의미를 배웁니다.","courseCards.41.title":"기독교 윤리","courseCards.41.body":"성경 원리로 현대 윤리 문제에 응답합니다.","courseCards.42.title":"아동교육","courseCards.42.body":"아동 사역과 신앙 교육의 이념과 실제.","courseCards.43.title":"비교종교","courseCards.43.body":"주요 종교를 이해하고 복음의 유일성을 붙듭니다.","courseCards.44.title":"이슬람 이해","courseCards.44.body":"이슬람을 이해하고 무슬림에게 다가갑니다.","courseCards.45.title":"삼인교회","courseCards.45.body":"가장 작은 단위로 시작하는 교회 개척 전략.","courseCards.46.title":"성경지리","courseCards.46.body":"지리 배경으로 성경 내러티브를 읽습니다.","courseCards.47.title":"세계관 이해","courseCards.47.body":"여러 세계관을 분별하고 성경적 관점을 세웁니다.","courseCards.48.title":"목회 사례연구","courseCards.48.body":"실제 목회 사례에서 배우는 교훈과 경계.","courseCards.49.title":"리더십","courseCards.49.body":"영적 리더십의 인격과 실천.","courseCards.50.title":"중국의 이단","courseCards.50.body":"이단을 분별하고 바른 믿음을 지킵니다.","courseCards.51.title":"능력기도","courseCards.51.body":"능력 있는 기도 생활과 사역을 배웁니다.","courses.filters.history":"역사","courses.filters.language":"언어","courses.filters.elective":"선택","training.0":"성경 통독 훈련(3회)","training.1":"성경 암송 훈련","training.2":"가정예배 훈련","training.3":"인간관계 훈련","training.4":"헌신 훈련","training.5":"설교 작성 100편(600쪽 이상)","training.6":"매일 1시간 기도(100일당 1학점)","training.7":"전도(5명당 1학점)","training.8":"Q.T 훈련(100일당 1학점)","training.9":"새벽기도(100일당 1학점)","training.10":"교회 개척","training.title":"영성 훈련과 졸업 요건","training.note":"석사 과정(G.Dip / M.Div)의 졸업 학점은 90점이며, 아래 훈련 항목은 학교의 확인으로 학점이 인정됩니다.","training.unit":"학점",
  "verse.courses":"“너는 진리의 말씀을 옫게 분별하며 부끄러울 것이 없는 일꾼으로 인정된 자로 자신을 하나님 앞에 드리기를 힘쓰라.”","verse.coursesRef":"— 디모데후서 2:15","verse.adm":"“나를 따라오라 내가 너희를 사람을 끬는 어부가 되게 하리라.”","verse.admRef":"— 마태복음 4:19","verse.life":"“철이 철을 날카롭게 하는 것 같이 사람이 그의 친구의 얼굴을 빛나게 하느니라.”","verse.lifeRef":"— 잠언 27:17","verse.digital":"“주의 말씀은 내 발에 등이요 내 길에 빛이니이다.”","verse.digitalRef":"— 시편 119:105","verse.res":"“모든 성경은 하나님의 감동으로 된 것으로 교훈과 책망과 바르게 함과 의로 교육하기에 유익하니.”","verse.resRef":"— 디모데후서 3:16",
  "footer.desc":"말씀과 기도에 뿌리내려 아시아의 추수밭으로 나아갈 일꾼을 세웁니다. 치앙마이 캠퍼스와 온라인 강의실이 중국어권 교회와 타문화 선교를 섬깁니다.","footer.c1":"학교","footer.c2":"배움","footer.c3":"시작하기",
  "faq.title":"자주 묻는 질문","faq.items.0.q":"신학 배경이 없어도 지원할 수 있나요?","faq.items.0.a":"네. 우리는 꾸준한 학습, 학습 규율 준수, 진지하게 훈련받으려는 의지를 더 중요하게 봅니다.","faq.items.1.q":"수업은 전부 온라인인가요?","faq.items.1.a":"유연 학습을 원칙으로 온라인 수업을 제공하며, 동시에 치앙마이 현장 제자훈련·실습·공동체 학습 참여를 권장합니다.","faq.items.2.q":"수료 후 학적 등록과 학위 수여는 누가 하나요?","faq.items.2.a":"학적은 AMAS 본교의 심사를 거쳐 등록되며, 학교의 정식 제도에 따라 졸업과 학위 절차가 진행됩니다.","faq.items.3.q":"지원은 어떻게 시작하나요?","faq.items.3.a":"「입학 지원」을 눌러 기본 정보와 학업 동기를 작성하시면, 이후 입학 담당자가 연락드려 다음 단계를 안내합니다.",
  "giving.cta":"동역 방법 알아보기","giving.ctaNote":"구체적인 방법은 담당자가 일대일로 안내합니다.",
  "giving.title":"후원과 동역","giving.verse":"“각각 그 마음에 정한 대로 할 것이요 인색함으로나 억지로 하지 말지니 하나님은 즐겁게 내는 자를 사랑하시느니라.”","giving.verseRef":"— 고린도후서 9:7","giving.desc":"신학 교육은 함께 세워가는 사역입니다. 당신의 후원은 훈련받기 원하는 학생이 학업을 마치도록 돕고, 교육과 선교 사역을 지탱합니다.","giving.d1":"학생 장학","giving.d1b":"경제적 어려움이 있는 학생의 훈련을 돕습니다","giving.d2":"교육 사역","giving.d2b":"교수진과 커리큘럼을 지원합니다","giving.d3":"선교사 훈련","giving.d3b":"파송을 준비하는 일꾼을 돕습니다","giving.ok":"접수되었습니다. 주님께서 당신의 드림을 기억하시기를!","giving.fail":"전송 실패. 잠시 후 다시 시도하거나 직접 연락해 주세요.","giving.note":"후원은 전적으로 자발적이며 학생 장학·교육·선교 사역에 사용됩니다. 사용 내역은 언제든 문의하실 수 있습니다.","faq.items.4.q":"AMAS를 어떻게 도울 수 있나요?","faq.items.4.a":"기도로 함께해 주세요. 학생 장학·교육·선교사 훈련을 위해 후원하실 수 있으며(「후원과 동역」 참조), 주변에 학교를 소개하는 것도 귀한 동역입니다.",
  "promo.tab":"2026학년도 모집 중","promo.title":"2026학년도 신학사 B.Th 모집 중","promo.desc":"온라인 + 치앙마이 오프라인 · 과목별 수강 · 9월 개강. 먼저 알아보고 싶으신가요? 입학 도우미가 언제든 답해 드립니다.","promo.ask":"바로 상담","promo.apply":"입학 지원","admissions.countdown":"2026년 9월 개강 · 모집 진행 중","admissions.started":"개강했습니다 — 다음 기수를 문의해 주세요","actions.copy":"복사","toast.copied":"복사되었습니다","faq.ask.title":"더 궁금한 점이 있으신가요?","faq.ask.desc":"AI 상담 도우미가 언제든 답해 드립니다. 입학 담당자에게 직접 메시지를 남기셔도 빠르게 회신드립니다.","faq.ask.ai":"AI 상담 도우미에게 묻기","faq.ask.leave":"입학처에 메시지 남기기",
  "contact.title":"더 알고 싶으신가요?","contact.desc":"질문을 남겨 주시면 남겨 주신 연락처로 회신드립니다.","contact.locationLabel":"지역","contact.studyLabel":"학습","contact.studyValue":"온라인 + 오프라인","contact.emailLabel":"이메일","contact.phoneLabel":"전화(태국)","contact.phoneCNLabel":"전화(중국)","contact.lineLabel":"Line","contact.wechatLabel":"위챗",
  "form.name":"이름","form.contact":"이메일 / Line / 위챗","form.message":"문의 내용","form.send":"문의 보내기",
  "form.okDemo":"접수되었습니다. 데모 버전은 문의를 브라우저에만 저장합니다.","form.ok":"접수되었습니다. 남겨 주신 연락처로 곧 연락드리겠습니다.","form.error":"제출 실패: 네트워크 또는 서버 오류입니다. 잠시 후 다시 시도하시거나 직접 연락해 주세요.",
  "video.title":"학교 소개 영상","video.placeholder":"영상 플레이어 자리가 준비되어 있습니다. YouTube / Vimeo / MP4 링크를 연결하면 됩니다.",
  "application.title":"입학 지원","application.hint":"온라인 지원은 빠른 통로입니다. 학력·가족 사항 등을 포함한 전체 지원서는 자료실에서 Word 문서로 내려받아 작성할 수 있습니다.","application.pleaseSelect":"선택해 주세요",
  "application.fields.nameZh":"이름(한자/중문)","application.fields.nameEn":"이름(영문)","application.fields.gender":"성별","application.fields.birth":"생년월","application.fields.nationality":"국적","application.fields.language":"주 사용 언어","application.fields.phone":"휴대전화","application.fields.email":"Email / QQ / 위챗","application.fields.city":"현재 거주 도시 / 국가",
  "application.fields.church":"현재 출석 교회","application.fields.churchType":"교회 유형","application.fields.conversion":"신앙 시작 시기(대략)","application.fields.baptism":"세례 시기(대략)","application.fields.role":"현재 섬김 / 역할","application.fields.referrer":"추천인과 연락처",
  "application.fields.program":"지원 과정","application.fields.eduLevel":"최종 학력","application.fields.eduSchool":"출신 학교(선택)","application.edu.secondary":"고졸 이하","application.edu.college":"전문학사","application.edu.bachelor":"학사","application.edu.master":"석사 이상","application.fields.mode":"선호하는 학습 방식","application.fields.gifts":"은사(선택)","application.fields.motivation":"비전과 소명 / 신앙 간증",
  "application.genders.male":"남","application.genders.female":"여",
  "application.languages.mandarin":"표준중국어","application.languages.cantonese":"광둥어","application.languages.other":"기타",
  "application.churchTypes.tspm":"삼자교회","application.churchTypes.house":"가정교회","application.churchTypes.other":"기타",
  "application.programs.bth":"신학사 B.Th(2026학년도 모집)","application.programs.gdip":"목회연구석사 G.Dip","application.programs.mdiv":"목회학석사 M.DIV","application.programs.dmin":"목회학 / 선교학박사 D.MIN / D.MISS","application.programs.pastor":"목회자 연수","application.programs.preaching":"설교학교","application.programs.missionary":"선교사 훈련",
  "application.modes.online":"온라인 중심","application.modes.onsite":"오프라인 중심","application.modes.hybrid":"온라인 + 오프라인",
  "application.consent":"위 정보가 사실임을 확인하며, 학교의 후속 연락과 입학 안내를 받는 데 동의합니다.","application.back":"이전","application.next":"다음","application.submit":"지원서 제출",
  "application.okDemo":"지원서가 데모 데이터로 저장되었습니다. 정식 오픈 시 백엔드 연동이 필요합니다.","application.ok":"지원서가 전송되었습니다. 입학 담당자가 곧 연락드리겠습니다.","application.error":"제출 실패: 네트워크 또는 서버 오류입니다. 잠시 후 다시 시도하시거나 아래 연락처로 문의해 주세요.",
  "application.stepOf":"4단계 중 {n}단계",
  "review.fullName":"이름(중문)","review.englishName":"이름(영문)","review.gender":"성별","review.birth":"생년월","review.nationality":"국적","review.language":"사용 언어","review.phone":"휴대전화","review.email":"Email / QQ / 위챗","review.location":"도시 / 국가","review.church":"교회","review.churchType":"교회 유형","review.conversionDate":"신앙 시작","review.baptismDate":"세례","review.role":"섬김 / 역할","review.referrer":"추천인","review.program":"지원 과정","review.eduLevel":"최종 학력","review.eduSchool":"출신 학교","review.mode":"학습 방식","review.gifts":"은사","review.motivation":"비전과 간증"
 },
 th: {
  "chat.open":"เปิดแชทสอบถาม","chat.title":"ผู้ช่วยรับสมัคร","chat.subtitle":"ตอบทันที · ฝากข้อความถึงฝ่ายรับสมัครได้","chat.placeholder":"พิมพ์คำถาม…","chat.send":"ส่ง","chat.note":"คำตอบอัตโนมัติอ้างอิงข้อมูลในเว็บไซต์นี้ ข้อความจะถูกส่งต่อให้ฝ่ายรับสมัคร",
  "chat.greeting":"สันติสุขครับ/ค่ะ! ฉันคือผู้ช่วยรับสมัครของวิทยาลัยพระคริสตธรรม AMAS ตอบคำถามเรื่องการสมัคร ค่าเล่าเรียน และรายวิชาได้ หรือจะฝากข้อความถึงฝ่ายรับสมัครโดยตรงก็ได้ อยากทราบเรื่องอะไรครับ/คะ?","chat.fallback":"คำถามนี้ยังไม่มีคำตอบที่แน่ชัด แนะนำให้ฝากข้อความถึงฝ่ายรับสมัคร แล้วจะติดต่อกลับโดยเร็ว",
  "chat.chips.apply":"สมัครอย่างไร?","chat.chips.tuition":"ค่าเล่าเรียนเท่าไร?","chat.chips.courses":"มีวิชาอะไรบ้าง?","chat.chips.mode":"เรียนอย่างไร?","chat.chips.leave":"ฝากข้อความถึงฝ่ายรับสมัคร",
  "chat.chips.human":"คุยกับเจ้าหน้าที่","chat.human.intro":"ได้เลย ติดต่อทีมงานรับสมัครได้โดยตรงทางช่องทางนี้ (ปกติตอบภายในวันเดียวกัน):","chat.human.wechat":"WeChat {id} · แตะเพื่อคัดลอก","chat.human.line":"Line {id} · แตะเพื่อคัดลอก","chat.human.note":"กรุณาระบุ \u201cสอบถาม AMAS\u201d เมื่อแอดเพื่อน หรือฝากข้อความไว้ที่นี่ ทีมงานจะติดต่อกลับ",
  "chat.kb.apply":"กด「สมัครเข้าเรียน」เพื่อกรอกใบสมัครออนไลน์ (ประมาณ 3 นาที) หลังส่งแล้วฝ่ายรับสมัครจะติดต่อกลับเพื่อแนะนำขั้นตอนต่อไป หรือดาวน์โหลดใบสมัครฉบับเต็ม (Word) ได้ที่ศูนย์ทรัพยากร",
  "chat.kb.tuition":"ค่าเล่าเรียนคิดเป็นรายวิชา จ่ายทีละวิชา จำนวนเงินโปรดสอบถามฝ่ายรับสมัครโดยตรง ผู้เรียนที่มีข้อจำกัดทางการเงินสามารถขอส่วนลด ผ่อนชำระ หรือความช่วยเหลืออื่นได้","chat.kb.tuitionBtn":"ดูค่าเล่าเรียนและการช่วยเหลือ",
  "chat.kb.courses":"หลักสูตรทางการมี 52 วิชา (รวมวิชาเลือก 13 วิชา) และรายการฝึกฝ่ายวิญญาณ หลักสูตร G.Dip / M.Div จบที่ 90 หน่วยกิต ครอบคลุมพระคัมภีร์ ศาสนศาสตร์ ประวัติศาสตร์ พันธกิจ และภาษาพระคัมภีร์","chat.kb.coursesBtn":"ดูรายวิชา",
  "chat.kb.programs":"หลักสูตรปริญญาเป็นระบบหน่วยกิต เรียนรายวิชา: B.Th (90)·G.Dip (90)·M.Div (90)·D.Min/D.Miss (48) หลักสูตรประกาศนียบัตรและอบรม: ผู้นำฆราวาส, ประกาศนียบัตรศิษยาภิบาล, อบรมศิษยาภิบาล, โรงเรียนเทศนา, อบรมมิชชันนารี เปิดรับ B.Th รุ่นปี 2026 เปิดเรียนกันยายน","chat.kb.programsBtn":"ดูหลักสูตร",
  "chat.kb.mode":"เรียนแบบยืดหยุ่นออนไลน์ + ออนไซต์: เน้นเรียนออนไลน์ พร้อมสนับสนุนให้เข้าร่วมการฝึกสาวกและภาคปฏิบัติที่เชียงใหม่ B.Th รุ่นปี 2026 เปิดเรียนกันยายน 2026",
  "chat.kb.contact":"ติดต่อเราได้ทางช่องทางต่อไปนี้:","chat.kb.contactEmpty":"ช่องทางติดต่อจะประกาศเร็ว ๆ นี้ ตอนนี้ฝากข้อความที่นี่ หรือใช้แบบฟอร์มสอบถามท้ายหน้าได้เลย",
  "chat.kb.location":"ศูนย์การศึกษาตั้งอยู่ที่เชียงใหม่ ประเทศไทย พร้อมการเรียนออนไลน์",
  "chat.kb.video":"เรามีวิดีโอแนะนำวิทยาลัย กดเพื่อรับชมได้",
  "chat.leave.askName":"ยินดีส่งต่อให้ครับ/ค่ะ ขอทราบชื่อของคุณ?","chat.leave.askContact":"ฝากช่องทางติดต่อ (WeChat / อีเมล / โทรศัพท์ ได้ทั้งหมด):","chat.leave.askContent":"ต้องการบอกอะไรกับฝ่ายรับสมัคร? พิมพ์ข้อความได้เลย:",
  "chat.leave.done":"ส่งข้อความแล้ว ฝ่ายรับสมัครจะติดต่อกลับโดยเร็ว มีคำถามอื่นอีกไหมครับ/คะ?","chat.leave.doneDemo":"บันทึกข้อความแล้ว (โหมดสาธิต) มีคำถามอื่นอีกไหม?","chat.leave.fail":"ขออภัย ส่งไม่สำเร็จ โปรดลองใหม่ภายหลัง หรือใช้แบบฟอร์มสอบถามท้ายหน้า",
  "brand.sub":"วิทยาลัยพระคริสตธรรม · ศูนย์เชียงใหม่","brand.zoom":"ดูตราวิทยาลัยขนาดใหญ่","brand.sealSub":"AMAS วิทยาลัยพระคริสตธรรม · ประเทศไทย",
  "announce.brand":"AMAS วิทยาลัยพระคริสตธรรม · ศูนย์เชียงใหม่","announce.verse":"“เราจะใช้ผู้ใดไป และผู้ใดจะไปแทนเรา” “ข้าพระองค์อยู่นี่ ขอทรงใช้ข้าพระองค์เถิด” — อิสยาห์ 6:8","announce.moto":"เตรียมสาวกวันนี้ · ส่งผู้รับใช้ในวันพรุ่งนี้","announce.hot":"รับสมัคร B.Th รุ่นปี 2026","announce.link":"ดูข้อมูลการรับสมัคร →",
  "nav.home":"หน้าแรก","nav.about":"เกี่ยวกับเรา","nav.courses":"รายวิชา","nav.admissions":"การรับสมัคร","nav.tuition":"ค่าเล่าเรียน","nav.life":"ชีวิตในวิทยาลัย","nav.resources":"ศูนย์ทรัพยากร","nav.contact":"ติดต่อเรา",
  "actions.apply":"สมัครเข้าเรียน","actions.login":"เข้าสู่ระบบ","actions.video":"ชมวิดีโอแนะนำ","actions.applyNow":"สมัครเลย","actions.download":"ดาวน์โหลด ↓","actions.view":"ดู →","actions.fill":"กรอก →","actions.skip":"ข้ามไปเนื้อหาหลัก","actions.backToTop":"↑ ขึ้นบน","actions.close":"ปิด","actions.sending":"กำลังส่ง…",
  "a11y.themeToNight":"สลับเป็นโหมดกลางคืน","a11y.themeToDay":"สลับเป็นโหมดกลางวัน","a11y.themeNight":"โหมดกลางคืน","a11y.themeDay":"โหมดกลางวัน","a11y.langSwitch":"เปลี่ยนภาษา (ปัจจุบันภาษาไทย)","a11y.openMenu":"เปิดเมนู","a11y.closeMenu":"ปิดเมนู",
  "toast.themeNight":"สลับเป็นโหมดกลางคืนแล้ว","toast.themeDay":"สลับเป็นโหมดกลางวันแล้ว","toast.applied":"ส่งใบสมัครแล้ว","toast.appliedDemo":"ส่งใบสมัครแล้ว (สาธิต)","toast.inquiry":"ส่งคำถามแล้ว","toast.inquiryDemo":"ส่งคำถามแล้ว (สาธิต)","toast.failed":"ส่งไม่สำเร็จ โปรดลองใหม่ภายหลัง","toast.downloaded":"ดาวน์โหลดไฟล์ตัวอย่างแล้ว",
  "meta.credits":"{n} หน่วยกิต","hero.title":"วิทยาลัยพระคริสตธรรมเอเชียมิชชัน","hero.sub":"ASIA MISSIONARY ASSOCIATION SEMINARY","hero.verse":"เหตุฉะนั้น ท่านทั้งหลายจงออกไปและนำชนทุกชาติมาเป็นสาวก","hero.verseRef":"— มัทธิว 28:19",
  "hero.ai.title":"ศาสนศาสตร์เฉพาะบุคคล · ดูสถานะการเติบโตแห่งความเชื่อใน 3 นาที","hero.ai.sub":"10 ข้อ · 5 ตัวชี้วัดเบื้องต้น · ก้าวต่อไปหนึ่งก้าว · Christian Profile ฉบับเต็มในแอป","hero.ai.go":"เริ่มสำรวจ →",
  "herometa.program":"หลักสูตร","herometa.programVal":"ศาสนศาสตรบัณฑิต B.Th","herometa.startVal":"กันยายน 2026","herometa.start":"รุ่นปี 2026 เปิดเรียน","herometa.mode":"การเรียน","herometa.modeVal":"ออนไลน์ + ออนไซต์",
  "accred.more":"ดูรายละเอียดการรับรอง →","accred.title":"การรับรองทางวิชาการ","accred.intro":"หลักสูตรปริญญาต่อไปนี้ของ AMAS ผ่านการประเมินรับรองจาก Asia Theological Association (ATA)","accred.bthName":"ศาสนศาสตรบัณฑิต Bachelor of Theology (B.Th.)","accred.mdivName":"ศาสนศาสตรมหาบัณฑิต Master of Divinity (M.Div.)","accred.dminName":"ศาสนศาสตรดุษฎีบัณฑิต Doctor of Ministry (D.Min.)","accred.bthNote":"รับรองโดย Asia Theological Association (ATA)","accred.note":"การรับรอง ATA ใช้กับหลักสูตรปริญญาที่ระบุข้างต้น ขอบเขตและอายุการรับรองเป็นไปตามเอกสารรับรองที่ ATA ออกให้",
  "actions.consult":"สอบถามการสมัคร","actions.applyBth":"สมัคร B.Th",
  "band.status":"ขึ้นทะเบียนนักศึกษาโดยการพิจารณาของวิทยาลัยหลัก","band.mode":"เรียนออนไลน์ + ฝึกภาคปฏิบัติที่เชียงใหม่","band.adm":"รับสมัคร B.Th รุ่นปี 2026",
  "admissions.facts.startLabel":"เปิดเรียน","admissions.facts.startValue":"กันยายน 2026","admissions.facts.feeLabel":"ค่าเล่าเรียน","admissions.facts.feeValue":"โปรดสอบถามฝ่ายรับสมัคร","admissions.facts.modeLabel":"รูปแบบ","admissions.facts.modeValue":"ออนไลน์ + ออนไซต์","admissions.facts.statusLabel":"สถานภาพ","admissions.facts.statusValue":"พิจารณาโดยวิทยาลัยหลัก",
  "admissions.consultBtn":"สอบถามก่อน 30 วินาที","admissions.applyBtn":"สมัครอย่างเป็นทางการ",
  "admissions.path.title1":"เพิ่งรู้จัก AMAS?","admissions.path.title2":"เริ่มจากการพูดคุยง่าย ๆ ก่อน","admissions.path.s1":"สอบถามด่วน","admissions.path.s1d":"ชื่อ + ช่องทางติดต่อ + เมือง + สิ่งที่อยากทราบ","admissions.path.s2":"พูดคุยกับฝ่ายรับสมัคร","admissions.path.s2d":"ยืนยันหลักสูตร สถานภาพ เวลา และความเหมาะสม","admissions.path.s3":"สมัครอย่างเป็นทางการ","admissions.path.s3d":"กรอกข้อมูลความเชื่อและการรับใช้ให้ครบถ้วน",
  "about.title":"AMAS วิทยาลัยพระคริสตธรรม<br>หยั่งรากในพระคัมภีร์ · มุ่งสู่โลกกว้าง","about.body":"เรามุ่งมั่นวางรากฐานบนความจริงแห่งพระคัมภีร์ ผสานวิสัยทัศน์ข้ามวัฒนธรรมกับการฝึกภาคปฏิบัติ เพื่อเตรียมผู้เรียนให้เป็นผู้ประกาศ ศิษยาภิบาล และมิชชันนารีที่สัตย์ซื่อ ดำเนินชีวิตตามข่าวประเสริฐและเป็นพยานถึงแผ่นดินของพระเจ้า","about.link":"ดูวิสัยทัศน์และพันธกิจของเรา",
  "pillars.bible.title":"พระคัมภีร์เป็นหลัก","pillars.bible.body":"ยึดมั่นสิทธิอำนาจของพระคัมภีร์ วางรากฐานความจริง สร้างความคิดทางศาสนศาสตร์และความเข้าใจฝ่ายวิญญาณที่มั่นคง",
  "pillars.practice.title":"เน้นภาคปฏิบัติ","pillars.practice.body":"ทฤษฎีคู่การปฏิบัติ ห้องเรียนคู่การรับใช้ เตรียมความสามารถที่ใช้ได้จริง",
  "pillars.mission.title":"วิสัยทัศน์มิชชัน","pillars.mission.body":"มองไปทั่วโลก เตรียมพร้อมข้ามวัฒนธรรม ตอบสนองพระมหาบัญชา",
  "pillars.life.title":"หล่อหลอมชีวิต","pillars.life.body":"ให้ความสำคัญกับชีวิตฝ่ายวิญญาณและอุปนิสัย เป็นคนงานที่ถูกพระทัยพระเจ้า",
  "stats.courses":"รายวิชาทางการ · เลือก 13","stats.flex.title":"เรียนยืดหยุ่น","stats.flex.body":"เรียนออนไลน์และออนไซต์ควบคู่กัน","stats.global.title":"มุมมองระดับโลก","stats.global.body":"การเรียนรู้ข้ามวัฒนธรรมและเครือข่ายมิชชัน","stats.team.title":"คณาจารย์ศิษยาภิบาล","stats.team.body":"ศิษยาภิบาลและอาจารย์ผู้มากประสบการณ์ร่วมเดินไปด้วยกัน","stats.year":"เริ่มรับสมัคร B.Th รุ่นปี 2026",
  "mission.aria":"วิสัยทัศน์และพันธกิจ","mission.title":"ไม่ใช่แค่เรียนจบหลักสูตร<br>แต่ถูกเตรียมเพื่อการรับใช้","mission.desc":"เรานำการศึกษาศาสนศาสตร์กลับสู่คริสตจักร ครอบครัว ที่ทำงาน และสนามมิชชันจริง ให้ความรู้ ชีวิต และการกระทำเชื่อมโยงกัน",
  "mission.vision.0":"สร้างศิษยาภิบาลและมิชชันนารีที่ถูกเตรียมด้วยพระวจนะและฤทธิ์เดชของพระวิญญาณบริสุทธิ์","mission.vision.1":"ก่อตั้งศูนย์มิชชันที่ถูกเตรียมด้วยพระวจนะและพระวิญญาณในประเทศต่าง ๆ ของเอเชีย","mission.vision.2":"ก่อตั้งโรงเรียนศาสนศาสตร์ที่เน้นพระคัมภีร์และการปฏิบัติในเอเชีย เพื่อสร้างศิษยาภิบาลและคนงานท้องถิ่น",
  "mission.items.0.title":"หยั่งรากในความจริง","mission.items.0.body":"วางรากฐานการตีความพระคัมภีร์และศาสนศาสตร์ที่เชื่อถือได้","mission.items.1.title":"หล่อหลอมชีวิต","mission.items.1.body":"เน้นวินัยฝ่ายวิญญาณ ความสัมพันธ์ในชุมชน และการเติบโตของอุปนิสัย","mission.items.2.title":"ฝึกภาคปฏิบัติ","mission.items.2.body":"เปลี่ยนสิ่งที่เรียนเป็นความสามารถในการเทศนา การเลี้ยงดู การสร้างสาวก และการรับใช้","mission.items.3.title":"ตอบสนองพันธกิจ","mission.items.3.body":"กล้าประกาศข่าวประเสริฐ พร้อมมุมมองและความสามารถในการมิชชันข้ามวัฒนธรรม",
  "courses.title":"รายวิชา","courses.desc":"หลักสูตรทางการ: วิชาบังคับ วิชาเลือก และการฝึกฝ่ายวิญญาณ ครอบคลุมพระคัมภีร์ ศาสนศาสตร์ระบบ ประวัติศาสตร์ ภาคปฏิบัติ และภาษาพระคัมภีร์","courses.filterGroup":"กรองรายวิชา","courses.filters.all":"ทั้งหมด","courses.filters.bible":"พระคัมภีร์","courses.filters.theology":"ศาสนศาสตร์","courses.filters.ministry":"การรับใช้","courses.filters.mission":"มิชชัน","courses.filters.formation":"ชีวิต","courses.count":"แสดง {n} รายวิชา","courses.more":"ดูรายวิชาทั้งหมด (อีก {n} วิชา)","courses.less":"ย่อรายการวิชา",
  "courseCards.0.title":"ภาพรวมพระคัมภีร์","courseCards.0.body":"มองภาพรวมโครงสร้าง เส้นเรื่อง และแผนการไถ่ตลอดทั้งเล่ม","courseCards.1.title":"มัทธิว","courseCards.1.body":"ศึกษาข่าวสารแผ่นดินสวรรค์ รู้จักพระคริสต์กษัตริย์และวิถีสาวก","courseCards.2.title":"ยอห์น","courseCards.2.body":"รู้จักพระเยซูว่าทรงเป็นผู้ใด และรับชีวิตโดยความเชื่อในพระนาม","courseCards.3.title":"กิจการของอัครทูต","courseCards.3.body":"ตามรอยคริสตจักรยุคแรก เห็นข่าวประเสริฐจากเยรูซาเล็มถึงสุดปลายแผ่นดินโลก","courseCards.4.title":"โรม","courseCards.4.body":"ศึกษาโครงร่างข่าวประเสริฐแห่งการชำระให้ชอบธรรมโดยความเชื่ออย่างเป็นระบบ","courseCards.5.title":"1 โครินธ์","courseCards.5.body":"ศึกษาจดหมายโดยเน้นระเบียบคริสตจักร ศาสนศาสตร์กางเขน และการสร้างชุมชน","courseCards.6.title":"2 โครินธ์","courseCards.6.body":"รู้จักการปลอบประโลมและฤทธิ์เดชของพระเจ้าในความอ่อนแอ และหน้าที่ผู้รับใช้","courseCards.7.title":"เอเฟซัส","courseCards.7.body":"รู้จักความล้ำลึกของคริสตจักรกายของพระคริสต์และชีวิตใหม่ในพระองค์","courseCards.8.title":"ฮีบรู","courseCards.8.body":"มองดูพระคริสต์มหาปุโรหิตผู้ประเสริฐกว่า ยึดมั่นความหวังที่เรารับไว้","courseCards.9.title":"วิวรณ์","courseCards.9.body":"เรียนรู้ความหวังวาระสุดท้ายและชัยชนะของคริสตจักรผ่านวรรณกรรมวิวรณ์",
  "courseCards.10.title":"ศาสนศาสตร์ระบบ 1","courseCards.10.body":"ภาพรวมหลักข้อเชื่อสำหรับฆราวาสและผู้เริ่มต้น วางกรอบความเชื่อ","courseCards.11.title":"ศาสนศาสตร์บริบท","courseCards.11.body":"คิด แสดงออก และปฏิบัติความเชื่ออย่างสัตย์ซื่อต่อพระคัมภีร์ในบริบทเอเชีย","courseCards.12.title":"การประกาศ","courseCards.12.body":"เรียนรู้ข่าวสาร วิธีการ และการติดตามผลของการประกาศข่าวประเสริฐ","courseCards.13.title":"การปรึกษาอภิบาล","courseCards.13.body":"ฝึกพื้นฐานการฟัง การให้คำปรึกษา และการเดินเคียงข้างฝ่ายวิญญาณ","courseCards.14.title":"กลุ่มย่อย","courseCards.14.body":"ก่อตั้ง นำ และขยายกลุ่มย่อยที่แข็งแรง","courseCards.15.title":"พันธกิจผู้เชื่อใหม่","courseCards.15.body":"ใช้สื่อการสอนอย่างเป็นระบบ ช่วยผู้เชื่อใหม่หยั่งรากและเข้าส่วนคริสตจักร","courseCards.16.title":"การบริหารคริสตจักร","courseCards.16.body":"ภาคปฏิบัติการบริหารคริสตจักร ตั้งแต่การปกครอง การร่วมงาน ถึงการวางแผนพันธกิจ","courseCards.17.title":"ศาสตร์การนมัสการ","courseCards.17.body":"เข้าใจความหมายตามพระคัมภีร์ของการนมัสการและการจัดระเบียบพิธี","courseCards.18.title":"การรักษาภายใน","courseCards.18.body":"รับการรักษาและการปลดปล่อยบาดแผลภายในด้วยความจริงและพระวิญญาณ","courseCards.19.title":"การรักษาโรค","courseCards.19.body":"เข้าใจหลักการและการปฏิบัติของการอธิษฐานเผื่อการรักษาบนรากฐานพระคัมภีร์","courseCards.20.title":"การรักษาด้วยพระวจนะ","courseCards.20.body":"เรียนรู้การประกาศพระวจนะ อธิษฐานวิงวอน และดูแลผู้เจ็บป่วย","courseCards.21.title":"สงครามฝ่ายวิญญาณ","courseCards.21.body":"เข้าใจหลักพระคัมภีร์เรื่องสงครามฝ่ายวิญญาณ สวมยุทธภัณฑ์ทั้งชุดของพระเจ้า","courseCards.22.title":"ชีวิตคริสเตียน","courseCards.22.body":"ฝึกฝนความเชื่อ ความยำเกรง และการเป็นพยานในชีวิตประจำวัน","courseCards.23.title":"การเลี้ยงดูฆราวาส (สาวก)","courseCards.23.body":"ติดตามพระคริสต์ในฐานะสาวก สร้างจังหวะชีวิตที่มั่นคง","courseCards.24.title":"การเลี้ยงดูฆราวาส (ความมั่นใจ)","courseCards.24.body":"สร้างความมั่นใจในความรอด ดำเนินชีวิตบนรากฐานความเชื่อที่มั่นคงและมีความหวัง",
  "programs.title":"หลักสูตร","programs.desc":"ระบบหน่วยกิต เรียนและชำระรายวิชา: จากประกาศนียบัตรถึงปริญญาเอก ครบหน่วยกิตก็จบการศึกษา เปิดรับ B.Th รุ่นปี 2026 หลักสูตรอื่นเปิดรับเช่นกัน สอบถามเพิ่มเติมได้",
  "programs.degree.title":"หลักสูตรปริญญา","programs.degree.sub":"เรียนรายวิชาแบบหน่วยกิต ครบตามกำหนดก็จบ ทะเบียนนักศึกษาตรวจสอบโดย AMAS สำนักงานใหญ่","programs.equip.title":"ประกาศนียบัตรและการอบรม","programs.equip.sub":"การอบรมระยะสั้นสำหรับศิษยาภิบาลและฆราวาส",
  "programs.items.laycert.badge":"ใบรับรอง","programs.items.laycert.name":"หลักสูตรผู้นำฆราวาส","programs.items.laycert.desc":"36 หน่วยกิต · เรียนเข้ม 10 วันทุก 3 เดือน · ครบหน่วยกิตรับใบสำเร็จ","programs.items.pdip.badge":"ประกาศนียบัตร","programs.items.pdip.name":"ประกาศนียบัตรการฝึกศิษยาภิบาล","programs.items.pdip.desc":"60 หน่วยกิต · เรียนออนไลน์รายวิชา · รับใบสำเร็จ","application.programs.laycert":"หลักสูตรผู้นำฆราวาส","application.programs.pdip":"ประกาศนียบัตรศิษยาภิบาล",
  "programs.items.bth.name":"ศาสนศาสตรบัณฑิต","programs.items.bth.desc":"รุ่นปี 2026 · เปิดเรียนกันยายน 2026 · 90 หน่วยกิต · เรียนรายวิชา ออนไลน์ + ออนไซต์",
  "programs.items.gdip.name":"ปริญญาโทศึกษาพันธกิจ (G.Dip)","programs.items.gdip.desc":"90 หน่วยกิต · เรียนรายวิชา · เรียนเพิ่มต่อยอด M.Div",
  "programs.items.mdiv.name":"ศาสนศาสตรมหาบัณฑิต","programs.items.mdiv.desc":"90 หน่วยกิต · เรียนรายวิชา · การเตรียมศาสนศาสตร์และศิษยาภิบาลเต็มรูปแบบ",
  "programs.items.dmin.name":"ดุษฎีบัณฑิตศาสนศาสตร์ / มิชชันวิทยา","programs.items.dmin.desc":"D.Min / D.Miss · 48 หน่วยกิต (รวมวิทยานิพนธ์) · วิจัยและปฏิบัติตามหน่วยกิต",
  "programs.items.pastor.badge":"อบรม","programs.items.pastor.name":"อบรมศิษยาภิบาล","programs.items.pastor.desc":"การเตรียมและฟื้นฟูอย่างต่อเนื่องสำหรับศิษยาภิบาลปัจจุบัน",
  "programs.items.preaching.badge":"เทศนา","programs.items.preaching.name":"โรงเรียนเทศนา","programs.items.preaching.desc":"ฝึกเข้มข้นตั้งแต่การตีความจนถึงการเทศนา",
  "programs.items.missionary.badge":"มิชชัน","programs.items.missionary.name":"อบรมมิชชันนารี","programs.items.missionary.desc":"การแยกแยะการทรงเรียกและเตรียมการส่งออกเพื่อพันธกิจข้ามวัฒนธรรม",
  "programs.note":"รอบเปิดเรียน ระยะเวลาเรียน และคุณสมบัติผู้สมัครของแต่ละหลักสูตร โปรดสอบถามผ่าน「สมัครเข้าเรียน」หรือช่องทางติดต่อฝ่ายรับสมัคร",
  "nav.programs":"หลักสูตร",
  "digital.title":"แคมปัสดิจิทัล","digital.desc":"วิทยาลัยกำลังสร้างแพลตฟอร์มการเรียนของตนเอง เชื่อมรายวิชา ทรัพยากร และชุมชนไว้ที่เดียว",
  "digital.items.0.title":"ห้องเรียนทางไกล","digital.items.0.body":"รวมวิชาที่กำลังเรียน ไลฟ์บรรยาย และวิดีโอย้อนหลังไว้ที่เดียว เหมาะกับการเรียนต่อเนื่องบนมือถือ",
  "digital.items.1.title":"ทรัพยากรห้องสมุด","digital.items.1.body":"เอกสาร เสียง และงานวิจัยปรากฏพร้อมกันในห้องสมุดและหน้ารายวิชา ลดการค้นหาไปมา",
  "digital.items.2.title":"ชุมชนศิษย์เก่า","digital.items.2.body":"การสนทนา อธิษฐานเผื่อ ฟีดแบ็กจากพี่เลี้ยง และห้องเสียง เชื่อมการเรียนกับชีวิตชุมชน",
  "digital.ai.cta":"สำรวจด่วน 3 นาที","digital.ai.ctaNote":"Christian Profile ฉบับเต็ม (12 แนวโน้มการรับใช้ วัดแยก 4 ด้าน) สร้างในแอป",
  "digital.app.web":"เปิดเว็บแอป",
  "digital.ai.title":"ศาสนศาสตร์เฉพาะบุคคล · AI","digital.ai.quote":"\u201cไม่ใช่ทุกคนต้องเริ่มจากวิชาเดียวกัน\u201d","digital.ai.body":"AI จะสนทนาเพื่อประเมินความเชื่อ ความรู้พระคัมภีร์ ศาสนศาสตร์ ชีวิต และบริบทการรับใช้ของคุณ สร้างโปรไฟล์การเติบโต และออกแบบเส้นทางการเตรียมเฉพาะคุณ พร้อมประเมินและปรับต่อเนื่องจนคุณถูกส่งออกไปรับใช้จริง","digital.ai.f0":"รู้จักคุณ","digital.ai.f1":"ประเมิน","digital.ai.f2":"โปรไฟล์","digital.ai.f3":"เส้นทางเฉพาะ","digital.ai.f4":"ปรับต่อเนื่อง","digital.items.3.title":"ทดลองเรียน","digital.items.3.body":"ฟังคอร์สเปิดฟรีที่คัดสรรก่อนตัดสินใจสมัคร","digital.items.4.title":"เส้นทางการเรียน","digital.items.4.body":"เห็นบันไดจากประกาศนียบัตรถึงดุษฎีบัณฑิตในภาพเดียว","digital.items.5.title":"ปรึกษาออนไลน์","digital.items.5.body":"ประกาศ ถาม-ตอบ และคำปรึกษาการสมัคร อยู่ในมือคุณ",
  "digital.note.label":"กำลังพัฒนา: ","digital.note.body":"แอปการเรียนอยู่ระหว่างทดสอบภายใน เปิดตัวเมื่อใดจะมีลิงก์ดาวน์โหลดที่นี่",
  "admissions.title":"รับสมัคร B.Th รุ่นปี 2026","admissions.desc":"เส้นทางการศึกษาศาสนศาสตร์ที่ยืดหยุ่นและเน้นปฏิบัติ สำหรับผู้ที่ตั้งใจรับการเตรียม เติบโตต่อเนื่อง และร่วมรับใช้","tuition.title":"ค่าเล่าเรียนและการช่วยเหลือ","tuition.motto":"ให้ทุกคนที่ปรารถนารับการเตรียม มีหนทางเรียนต่อไปได้","tuition.mode":"เรียนรายวิชา · จ่ายรายวิชา",
  "tuition.p1":"AMAS ใช้ระบบเรียนรายวิชา จ่ายรายวิชา ผู้เรียนเลือกวิชาตามความก้าวหน้าของตน ไม่ต้องจ่ายทั้งเทอมหรือทั้งปีในครั้งเดียว ทำให้วางแผนเรียนได้ยืดหยุ่นและลดภาระการเงิน จำนวนค่าเล่าเรียนโปรดสอบถามฝ่ายรับสมัครโดยตรง",
  "tuition.p2":"เราเชื่อว่าการเตรียมด้านศาสนศาสตร์ต้องการความทุ่มเทของผู้เรียน และมีต้นทุนการสอนที่วิทยาลัย อาจารย์ และทีมรับใช้ร่วมกันแบกรับ การชำระค่าเล่าเรียนตามปกติจึงเป็นทั้งความมุ่งมั่นต่อการเรียนและการสนับสนุนพันธกิจการสอน",
  "tuition.v1":"“เพราะว่าถ้ามีใจพร้อมอยู่แล้ว พระเจ้าก็พอพระทัยที่จะทรงรับตามที่เขามีอยู่ ไม่ใช่ตามที่เขาไม่มี”","tuition.v1ref":"—— 2 โครินธ์ 8:12",
  "tuition.p3":"ดังนั้น ความยากลำบากทางการเงินไม่ควรเป็นอุปสรรคต่อการรับการเตรียมด้านศาสนศาสตร์ ผู้เรียนที่มีข้อจำกัดจริงแต่ตั้งใจเรียน สามารถแจ้งสถานการณ์กับฝ่ายรับสมัครหรือฝ่ายวิชาการ วิทยาลัยจะพิจารณาเป็นรายบุคคลเพื่อให้ส่วนลด ผ่อนชำระ หรือการช่วยเหลืออื่นตามความเหมาะสม",
  "tuition.p4":"หลักการของเราไม่ใช่แค่ “ลดค่าเล่าเรียน” แต่คือช่วยให้ทุกคนที่ตั้งใจเรียนจริง พบหนทางที่จะรับการเตรียมต่อไปได้",
  "tuition.v2":"“ส่วนผู้ที่รับคำสอน จงแบ่งสิ่งดีทุกอย่างให้แก่ผู้ที่สอนตน”","tuition.v2ref":"—— กาลาเทีย 6:6",
  "tuition.p5":"AMAS ปรารถนาสร้างวัฒนธรรมการเรียนที่ดี ผู้ที่มีกำลังชำระค่าเล่าเรียนตามปกติ ผู้ที่ลำบากได้รับความช่วยเหลือ และผู้ที่มีเหลือสามารถ<a href=\"#giving\">ถวาย</a>เพื่อสนับสนุนผู้เรียนคนอื่น",
  "tuition.ctaFee":"สอบถามค่าเล่าเรียน","tuition.ctaAid":"ขอรับการช่วยเหลือ",
  "tuition.pr.title":"หลักการค่าเล่าเรียน","tuition.pr.0":"ค่าเล่าเรียนคิดเป็นรายวิชา จำนวนเงินโปรดสอบถามฝ่ายรับสมัคร","tuition.pr.1":"จ่ายรายวิชา ไม่ต้องจ่ายทั้งปีในครั้งเดียว","tuition.pr.2":"ผู้มีข้อจำกัดทางการเงินขอรับการพิจารณาและช่วยเหลือเป็นรายบุคคลได้","tuition.pr.3":"วิทยาลัยไม่ปฏิเสธผู้แสวงหาการเตรียมอย่างจริงจังเพียงเพราะเหตุผลทางการเงิน","tuition.pr.4":"ส่วนลด การผ่อนชำระ และการช่วยเหลือ กำหนดโดยการปรึกษาเป็นรายบุคคล",
  "life.title":"การเรียนไม่ได้เกิดขึ้นอย่างโดดเดี่ยว","life.desc":"ห้องเรียน การฝึกสาวก กลุ่มย่อย การรับใช้ในคริสตจักร และชีวิตจริง ร่วมกันประกอบเป็นการศึกษาศาสนศาสตร์","life.items.0.title":"พี่เลี้ยงเดินเคียงข้าง","life.items.0.body":"นอกห้องเรียน เราให้ความสำคัญกับการเดินเคียงข้างชีวิตและการแยกแยะทิศทาง","life.items.0.p0":"การเดินเคียงข้างและอธิษฐานเผื่อแบบตัวต่อตัวสม่ำเสมอ","life.items.0.p1":"การแยกแยะทิศทางการเรียนและการทรงเรียก","life.items.0.p2":"เครือข่ายฝ่ายวิญญาณร่วมกับศิษยาภิบาลผู้มากประสบการณ์","life.items.1.title":"เรียนเป็นกลุ่มย่อย","life.items.1.body":"เรียนลึกขึ้นผ่านการสนทนา กรณีศึกษา และการตอบสนองซึ่งกันและกัน","life.items.1.p0":"กลุ่มเรียนประจำ ดูแลกันและกัน","life.items.1.p1":"สนทนารายวิชา แบ่งปันกรณีศึกษา ตอบสนองกัน","life.items.1.p2":"ชีวิตสามัคคีธรรมออนไลน์ข้ามภูมิภาค","life.items.2.title":"รับใช้ภาคปฏิบัติ","life.items.2.body":"นำสิ่งที่เรียนไปสู่คริสตจักร ครอบครัว ที่ทำงาน และสนามมิชชัน","life.items.2.p0":"ตำแหน่งรับใช้ร่วมกับคริสตจักรท้องถิ่น","life.items.2.p1":"การฝึกประกาศ สร้างสาวก เยี่ยมเยียน ฯลฯ","life.items.2.p2":"การฝึกเข้มข้นและสัปดาห์ปฏิบัติที่เชียงใหม่","life.items.3.title":"นมัสการและภาวนา","life.items.3.body":"หยั่งรากในการนมัสการและอธิษฐาน ชีวิตมาก่อนการรับใช้","life.items.3.p0":"วินัยภาวนาและอธิษฐานสม่ำเสมอ","life.items.3.p1":"ร่วมนมัสการและรับใช้ในพิธีนมัสการ","life.items.3.p2":"สร้างความยำเกรงและอุปนิสัยในชุมชน",
  "life.rhythm.title":"จังหวะการเรียนรายสัปดาห์","life.rhythm.0":"เรียนออนไลน์และอ่านตามที่กำหนด","life.rhythm.1":"สนทนากลุ่มย่อยและตอบสนองกัน","life.rhythm.2":"ฝึกสาวกและเวลากับพี่เลี้ยง","life.rhythm.3":"รับใช้คริสตจักรและปฏิบัติในชีวิตจริง",
  "resources.title":"ศูนย์ทรัพยากร","resources.searchLabel":"ค้นหาทรัพยากร","resources.searchPlaceholder":"ค้นหา…","resources.count":"พบ {n} รายการ","resources.items.0":"คู่มือนักศึกษาใหม่","resources.items.1":"รายวิชา B.Th","resources.items.2":"ค่าเล่าเรียนและการช่วยเหลือ","resources.items.3":"สมัครออนไลน์ (ช่องทางด่วน)","resources.items.4":"ใบสมัครฉบับเต็ม (Word)","resources.items.5":"อัปโหลดใบสมัครที่กรอกแล้ว","actions.upload":"อัปโหลด ↑","upload.name":"ชื่อ","upload.contact":"ช่องทางติดต่อ (อีเมล / WeChat / โทรศัพท์)","upload.file":"เลือกใบสมัครที่กรอกแล้ว (Word หรือ PDF)","upload.submit":"อัปโหลดและส่ง","upload.note":"เอกสารจะส่งตรงถึงอีเมลฝ่ายรับสมัคร หลังส่งจะแสดงหน้ายืนยันในแท็บใหม่",
  "courseCards.25.title":"ศาสนศาสตร์ระบบ 2","courseCards.25.body":"ศึกษาต่อเรื่องพระคริสต์วิทยาและความรอด","courseCards.26.title":"ศาสนศาสตร์ระบบ 3","courseCards.26.body":"คริสตจักรวิทยาและอวสานวิทยาอย่างบูรณาการ","courseCards.27.title":"วัฒนธรรมอิสราเอล","courseCards.27.body":"ประวัติศาสตร์และวัฒนธรรมอิสราเอลเบื้องหลังพระคัมภีร์","courseCards.28.title":"ประวัติคริสตจักรโลก","courseCards.28.body":"สองพันปีแห่งเส้นทางและมรดกของคริสตจักร","courseCards.29.title":"ประวัติคริสตจักรจีน","courseCards.29.body":"การมาถึงของข่าวประเสริฐและการเติบโตของคริสตจักรจีน","courseCards.30.title":"ภาษากรีก","courseCards.30.body":"พื้นฐานภาษากรีกเพื่ออ่านพันธสัญญาใหม่ฉบับเดิม","courseCards.31.title":"ภาษาฮีบรูเบื้องต้น","courseCards.31.body":"องค์ประกอบเบื้องต้นของภาษาฮีบรู","courseCards.32.title":"สื่อการสอนผู้เชื่อใหม่","courseCards.32.body":"การจัดทำและใช้สื่อเลี้ยงดูผู้เชื่อใหม่","courseCards.33.title":"ศาสตร์การเทศนา","courseCards.33.body":"จากการตีความสู่การเรียบเรียงคำเทศนาที่สัตย์ซื่อ","courseCards.34.title":"ฝึกเทศนา 1","courseCards.34.body":"ฝึกพื้นฐานการเทศนาบนธรรมาสน์จริง","courseCards.35.title":"ฝึกเทศนา 2","courseCards.35.body":"ฝึกขั้นสูงพร้อมคำวิจารณ์เพื่อสร้างสไตล์การเทศนา","courseCards.36.title":"การนำนมัสการ","courseCards.36.body":"หลักการและทักษะการนำที่ประชุมนมัสการ","courseCards.37.title":"การรักษาภายในหนึ่งวัน","courseCards.37.body":"หลักสูตรปฏิบัติการรักษาภายในแบบเข้มข้นหนึ่งวัน","courseCards.38.title":"คอมพิวเตอร์ประยุกต์","courseCards.38.body":"เอกสาร สไลด์ และเครื่องมือออนไลน์เพื่อพันธกิจ","courseCards.39.title":"ปฐมกาล","courseCards.39.body":"การทรงสร้าง การล้มลง และจุดเริ่มต้นแห่งการไถ่","courseCards.40.title":"เลวีนิติ","courseCards.40.body":"ความบริสุทธิ์และการนมัสการผ่านเครื่องบูชาและเทศกาล","courseCards.41.title":"จริยธรรมคริสเตียน","courseCards.41.body":"ตอบประเด็นจริยธรรมร่วมสมัยด้วยหลักพระคัมภีร์","courseCards.42.title":"การศึกษาเด็ก","courseCards.42.body":"แนวคิดและภาคปฏิบัติของพันธกิจเด็ก","courseCards.43.title":"ศาสนาเปรียบเทียบ","courseCards.43.body":"ศาสนาหลักต่าง ๆ กับความล้ำเลิศของข่าวประเสริฐ","courseCards.44.title":"ความเข้าใจอิสลาม","courseCards.44.body":"เข้าใจอิสลามและการประกาศแก่ชาวมุสลิม","courseCards.45.title":"คริสตจักรสามคน","courseCards.45.body":"กลยุทธ์บุกเบิกคริสตจักรจากหน่วยเล็กที่สุด","courseCards.46.title":"ภูมิศาสตร์พระคัมภีร์","courseCards.46.body":"อ่านเรื่องราวพระคัมภีร์ผ่านภูมิศาสตร์","courseCards.47.title":"ความเข้าใจโลกทัศน์","courseCards.47.body":"แยกแยะโลกทัศน์ต่าง ๆ ด้วยมุมมองพระคัมภีร์","courseCards.48.title":"กรณีศึกษาการอภิบาล","courseCards.48.body":"บทเรียนจากกรณีการอภิบาลจริง","courseCards.49.title":"ภาวะผู้นำ","courseCards.49.body":"อุปนิสัยและการปฏิบัติของผู้นำฝ่ายวิญญาณ","courseCards.50.title":"ลัทธิเทียมเท็จในจีน","courseCards.50.body":"แยกแยะลัทธิเทียมเท็จและยึดมั่นความเชื่อบริสุทธิ์","courseCards.51.title":"การอธิษฐานด้วยฤทธิ์เดช","courseCards.51.body":"ชีวิตอธิษฐานและการรับใช้ที่เปี่ยมฤทธิ์เดช","courses.filters.history":"ประวัติศาสตร์","courses.filters.language":"ภาษา","courses.filters.elective":"วิชาเลือก","training.0":"อ่านพระคัมภีร์ตลอดเล่ม (3 รอบ)","training.1":"ท่องจำพระคัมภีร์","training.2":"ฝึกนมัสการครอบครัว","training.3":"ฝึกความสัมพันธ์","training.4":"ฝึกการถวายตัว","training.5":"เขียนคำเทศนา 100 เรื่อง (600 หน้าขึ้นไป)","training.6":"อธิษฐานวันละ 1 ชั่วโมง (100 วัน = 1 หน่วยกิต)","training.7":"การประกาศ (5 คน = 1 หน่วยกิต)","training.8":"เฝ้าเดี่ยว Q.T (100 วัน = 1 หน่วยกิต)","training.9":"อธิษฐานรุ่งเช้า (100 วัน = 1 หน่วยกิต)","training.10":"บุกเบิกคริสตจักร","training.title":"การฝึกฝ่ายวิญญาณและเกณฑ์การจบ","training.note":"หลักสูตร G.Dip / M.Div ต้องได้ 90 หน่วยกิตจึงจบการศึกษา รายการฝึกด้านล่างได้รับการตรวจและรับรองหน่วยกิตโดยวิทยาลัย","training.unit":"หน่วยกิต",
  "verse.courses":"“จงอุตส่าห์สำแดงตนให้เป็นที่พอพระทัยพระเจ้า เป็นคนงานที่ไม่ต้องอาย ใช้พระวจนะแห่งความจริงอย่างถูกต้อง”","verse.coursesRef":"— 2 ทิโมธี 2:15","verse.adm":"“จงตามเรามา และเราจะตั้งท่านให้เป็นผู้หาคนดั่งหาปลา”","verse.admRef":"— มัทธิว 4:19","verse.life":"“เหล็กลับเหล็กได้ฉันใด คนหนึ่งก็ลับเพื่อนของตนได้ฉันนั้น”","verse.lifeRef":"— สุภาษิต 27:17","verse.digital":"“พระวจนะของพระองค์เป็นโคมสำหรับเท้าของข้าพระองค์ และเป็นความสว่างแก่ทางของข้าพระองค์”","verse.digitalRef":"— สดุดี 119:105","verse.res":"“พระคัมภีร์ทุกตอนได้รับการดลใจจากพระเจ้า และเป็นประโยชน์ในการสอน การตักเตือน การแก้ไขสิ่งผิด และการอบรมในความชอบธรรม”","verse.resRef":"— 2 ทิโมธี 3:16",
  "footer.desc":"หยั่งรากในพระคัมภีร์และการอธิษฐาน เตรียมผู้รับใช้สู่ทุ่งนาแห่งเอเชีย ศูนย์เชียงใหม่และห้องเรียนออนไลน์ร่วมรับใช้คริสตจักรจีนและพันธกิจข้ามวัฒนธรรม","footer.c1":"วิทยาลัย","footer.c2":"การเรียน","footer.c3":"เริ่มต้น",
  "faq.title":"คำถามที่พบบ่อย","faq.items.0.q":"ไม่มีพื้นฐานศาสนศาสตร์ สมัครได้ไหม?","faq.items.0.a":"ได้ เราให้ความสำคัญกับการเรียนอย่างต่อเนื่อง การรักษาวินัยการเรียน และความตั้งใจรับการเตรียมมากกว่า","faq.items.1.q":"เรียนออนไลน์ทั้งหมดหรือไม่?","faq.items.1.a":"ยึดหลักเรียนยืดหยุ่น มีวิชาออนไลน์ พร้อมสนับสนุนให้ร่วมการฝึกสาวก ภาคปฏิบัติ และการเรียนแบบชุมชนที่เชียงใหม่","faq.items.2.q":"จบแล้วใครขึ้นทะเบียนสถานภาพและมอบปริญญา?","faq.items.2.a":"สถานภาพนักศึกษาขึ้นทะเบียนโดยการพิจารณาของวิทยาลัยหลัก AMAS และดำเนินการจบการศึกษาและปริญญาตามระบบทางการของวิทยาลัย","faq.items.3.q":"เริ่มสมัครอย่างไร?","faq.items.3.a":"กด「สมัครเข้าเรียน」กรอกข้อมูลพื้นฐานและแรงจูงใจ จากนั้นฝ่ายรับสมัครจะติดต่อและแนะนำขั้นตอนต่อไป",
  "giving.cta":"ดูวิธีมีส่วนร่วม","giving.ctaNote":"ทีมงานจะแนะนำรายละเอียดเป็นการส่วนตัว",
  "giving.title":"ถวายสนับสนุน","giving.verse":"“ทุกคนจงให้ตามที่ตนคิดหมายไว้ในใจ มิใช่ด้วยนิสัยเสียดายหรือด้วยความจำใจ เพราะว่าพระเจ้าทรงรักคนที่ให้ด้วยใจยินดี”","giving.verseRef":"— 2 โครินธ์ 9:7","giving.desc":"การศึกษาศาสนศาสตร์เป็นพันธกิจที่ร่วมกันทำ การถวายของคุณช่วยให้ผู้เรียนเรียนจนจบ และหนุนการสอนกับพันธกิจมิชชัน","giving.d1":"ทุนการศึกษา","giving.d1b":"ช่วยผู้เรียนที่ขาดแคลนทุนทรัพย์","giving.d2":"พันธกิจการสอน","giving.d2b":"สนับสนุนคณาจารย์และหลักสูตร","giving.d3":"อบรมมิชชันนารี","giving.d3b":"สนับสนุนผู้เตรียมถูกส่งออก","giving.ok":"ได้รับแล้ว ขอพระเจ้าทรงระลึกถึงของถวายของคุณ!","giving.fail":"ส่งไม่สำเร็จ โปรดลองใหม่หรือติดต่อเรา","giving.note":"การถวายเป็นไปโดยสมัครใจ ใช้เพื่อทุนการศึกษา การสอน และมิชชัน สอบถามการใช้ได้ทุกเมื่อ","faq.items.4.q":"จะสนับสนุน AMAS ได้อย่างไร?","faq.items.4.a":"อธิษฐานเผื่อเรา ถวายเพื่อทุนการศึกษา การสอน หรืออบรมมิชชันนารี (ดูส่วนถวายสนับสนุน) หรือแนะนำวิทยาลัยให้คนที่เหมาะสม",
  "promo.tab":"เปิดรับสมัครรุ่น 2026","promo.title":"เปิดรับสมัคร B.Th รุ่นปี 2026","promo.desc":"ออนไลน์ + ออนไซต์เชียงใหม่ · เรียนรายวิชา · เปิดเรียน ก.ย. 2026 อยากทราบเพิ่มเติม? ผู้ช่วยรับสมัครพร้อมตอบทุกเมื่อ","promo.ask":"สอบถามเลย","promo.apply":"สมัครเรียน","admissions.countdown":"เปิดเรียนกันยายน 2026 · กำลังรับสมัคร","admissions.started":"เปิดเรียนแล้ว — สอบถามรุ่นถัดไปได้","actions.copy":"คัดลอก","toast.copied":"คัดลอกแล้ว","faq.ask.title":"ยังมีคำถามอื่นอีกไหม?","faq.ask.desc":"ผู้ช่วย AI ตอบได้ตลอดเวลา หรือฝากข้อความถึงฝ่ายรับสมัครโดยตรง เราจะติดต่อกลับโดยเร็ว","faq.ask.ai":"ถามผู้ช่วย AI","faq.ask.leave":"ฝากข้อความถึงฝ่ายรับสมัคร",
  "contact.title":"อยากรู้จักเรามากขึ้น?","contact.desc":"ฝากคำถามไว้ แล้วเราจะติดต่อกลับตามช่องทางที่คุณให้ไว้","contact.locationLabel":"ที่ตั้ง","contact.studyLabel":"การเรียน","contact.studyValue":"ออนไลน์ + ออนไซต์","contact.emailLabel":"อีเมล","contact.phoneLabel":"โทร (ไทย)","contact.phoneCNLabel":"โทร (จีน)","contact.lineLabel":"Line","contact.wechatLabel":"WeChat",
  "form.name":"ชื่อ","form.contact":"อีเมล / Line / WeChat","form.message":"เรื่องที่ต้องการสอบถาม","form.send":"ส่งคำถาม",
  "form.okDemo":"ได้รับแล้ว เวอร์ชันสาธิตจะบันทึกคำถามไว้ในเบราว์เซอร์ของคุณ","form.ok":"ได้รับแล้ว เราจะติดต่อกลับตามช่องทางที่ให้ไว้โดยเร็ว","form.error":"ส่งไม่สำเร็จ: เครือข่ายหรือเซิร์ฟเวอร์ขัดข้อง โปรดลองใหม่ หรือติดต่อเราโดยตรง",
  "video.title":"วิดีโอแนะนำวิทยาลัย","video.placeholder":"พื้นที่เครื่องเล่นวิดีโอเตรียมไว้แล้ว เชื่อมลิงก์ YouTube / Vimeo / MP4 ได้ภายหลัง",
  "application.title":"สมัครเข้าเรียน","application.hint":"การสมัครออนไลน์คือช่องทางด่วน ใบสมัครฉบับเต็ม (รวมประวัติการศึกษา ครอบครัว ฯลฯ) ดาวน์โหลดเป็นไฟล์ Word ได้ที่ศูนย์ทรัพยากร","application.pleaseSelect":"โปรดเลือก",
  "application.fields.nameZh":"ชื่อ (ภาษาจีน)","application.fields.nameEn":"ชื่อ (ภาษาอังกฤษ)","application.fields.gender":"เพศ","application.fields.birth":"เดือน/ปีเกิด","application.fields.nationality":"สัญชาติ","application.fields.language":"ภาษาหลักที่ใช้","application.fields.phone":"โทรศัพท์มือถือ","application.fields.email":"Email / QQ / WeChat","application.fields.city":"เมือง / ประเทศที่อยู่ปัจจุบัน",
  "application.fields.church":"คริสตจักรที่ร่วมปัจจุบัน","application.fields.churchType":"ประเภทคริสตจักร","application.fields.conversion":"เริ่มเชื่อเมื่อ (โดยประมาณ)","application.fields.baptism":"รับบัพติศมาเมื่อ (โดยประมาณ)","application.fields.role":"งานรับใช้ / บทบาทปัจจุบัน","application.fields.referrer":"ผู้แนะนำและเบอร์ติดต่อ",
  "application.fields.program":"หลักสูตรที่สมัคร","application.fields.eduLevel":"วุฒิการศึกษาสูงสุด","application.fields.eduSchool":"สถาบันที่จบ (ไม่บังคับ)","application.edu.secondary":"มัธยมปลายหรือต่ำกว่า","application.edu.college":"อนุปริญญา","application.edu.bachelor":"ปริญญาตรี","application.edu.master":"ปริญญาโทขึ้นไป","application.fields.mode":"รูปแบบเรียนที่ต้องการ","application.fields.gifts":"ของประทาน (ไม่บังคับ)","application.fields.motivation":"นิมิตกับการทรงเรียก / คำพยานความเชื่อ",
  "application.genders.male":"ชาย","application.genders.female":"หญิง",
  "application.languages.mandarin":"จีนกลาง","application.languages.cantonese":"กวางตุ้ง","application.languages.other":"อื่น ๆ",
  "application.churchTypes.tspm":"คริสตจักรสามอิสระ","application.churchTypes.house":"คริสตจักรบ้าน","application.churchTypes.other":"อื่น ๆ",
  "application.programs.bth":"ศาสนศาสตรบัณฑิต B.Th (รุ่นปี 2026)","application.programs.gdip":"G.Dip","application.programs.mdiv":"ศาสนศาสตรมหาบัณฑิต M.DIV","application.programs.dmin":"ดุษฎีบัณฑิต D.MIN / D.MISS","application.programs.pastor":"อบรมศิษยาภิบาล","application.programs.preaching":"โรงเรียนเทศนา","application.programs.missionary":"อบรมมิชชันนารี",
  "application.modes.online":"ออนไลน์เป็นหลัก","application.modes.onsite":"ออนไซต์เป็นหลัก","application.modes.hybrid":"ออนไลน์ + ออนไซต์",
  "application.consent":"ข้าพเจ้ายืนยันว่าข้อมูลข้างต้นเป็นความจริง และยินดีรับการติดต่อและคำแนะนำการเข้าเรียนจากวิทยาลัย","application.back":"ย้อนกลับ","application.next":"ถัดไป","application.submit":"ส่งใบสมัคร",
  "application.okDemo":"ใบสมัครถูกบันทึกเป็นข้อมูลสาธิตในเครื่องนี้ เวอร์ชันจริงต้องเชื่อมระบบหลังบ้าน","application.ok":"ส่งใบสมัครแล้ว ฝ่ายรับสมัครจะติดต่อกลับโดยเร็ว","application.error":"ส่งไม่สำเร็จ: เครือข่ายหรือเซิร์ฟเวอร์ขัดข้อง โปรดลองใหม่ หรือติดต่อตามช่องทางด้านล่าง",
  "application.stepOf":"ขั้นตอนที่ {n} จาก 4",
  "review.fullName":"ชื่อ (จีน)","review.englishName":"ชื่อ (อังกฤษ)","review.gender":"เพศ","review.birth":"เดือน/ปีเกิด","review.nationality":"สัญชาติ","review.language":"ภาษาที่ใช้","review.phone":"มือถือ","review.email":"Email / QQ / WeChat","review.location":"เมือง / ประเทศ","review.church":"คริสตจักร","review.churchType":"ประเภทคริสตจักร","review.conversionDate":"เริ่มเชื่อ","review.baptismDate":"บัพติศมา","review.role":"งานรับใช้","review.referrer":"ผู้แนะนำ","review.program":"หลักสูตร","review.eduLevel":"วุฒิสูงสุด","review.eduSchool":"สถาบัน","review.mode":"รูปแบบเรียน","review.gifts":"ของประทาน","review.motivation":"นิมิตและคำพยาน"
 }
};

let currentLang = "zh";
try{ currentLang = localStorage.getItem("amas-lang") || "zh"; }catch(e){}
try{ const urlLang = new URLSearchParams(location.search).get("lang"); if(urlLang && i18n[urlLang]) currentLang = urlLang; }catch(e){}
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
  document.documentElement.lang = ({ zh:"zh-CN", en:"en", ko:"ko", th:"th" })[currentLang] || "zh-CN";

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
  if(typeof refreshLangMenu === "function") refreshLangMenu();
  const fd = $("#formDl");
  if(fd && CONFIG.applicationForm) fd.href = CONFIG.applicationForm[currentLang] || CONFIG.applicationForm.zh;
  if(typeof refreshCountdown === "function") refreshCountdown();
  applyCourseVisibility();
  announceResourceCount();
}
/* 四语言下拉切换 */
const LANG_LABELS = { zh:"中文", en:"English", ko:"한국어", th:"ไทย" };
function refreshLangMenu(){
  const cur = $("#langCurrent");
  if(cur) cur.textContent = LANG_LABELS[currentLang] || "中文";
  $$("#langList button").forEach(b => b.classList.toggle("active", b.dataset.lang === currentLang));
}
function closeLangList(){
  const l = $("#langList");
  if(l && !l.hidden){ l.hidden = true; $("#langBtn").setAttribute("aria-expanded","false"); }
}
$("#langBtn").addEventListener("click", () => {
  const l = $("#langList");
  l.hidden = !l.hidden;
  $("#langBtn").setAttribute("aria-expanded", String(!l.hidden));
});
$$("#langList button").forEach(b => b.addEventListener("click", () => {
  applyLanguage(b.dataset.lang);
  closeLangList();
}));
document.addEventListener("click", e => { if(!e.target.closest(".lang-menu")) closeLangList(); });
refreshLangMenu();


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
const NAV_ALIAS = { tuition:"admissions", mission:"about", programs:"courses" };
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
  let real = CONFIG.resources?.[key];
  if(real && typeof real === "object") real = real[currentLang] || real.zh;
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
/* 数据库通道：SUPA 配置后，每次成功提交同时写入 Supabase（静默失败，绝不影响邮件通道） */
function logToDB(kind, payload){
  const S = window.SUPA || {};
  if(!S.url || !S.anonKey) return;
  const data = {};
  for(const k in payload){ if(!k.startsWith("_")) data[k] = payload[k]; }
  const rec = {
    type: kind,
    name: String(payload.fullName || payload.name || payload["姓名"] || ""),
    contact: String(payload.email || payload.contact || payload.phone || payload["联系方式"] || ""),
    program: String(payload.program || ""),
    lang: String(payload.lang || currentLang || ""),
    data
  };
  try{
    fetch(S.url + "/rest/v1/submissions", {
      method: "POST",
      headers: { apikey: S.anonKey, Authorization: "Bearer " + S.anonKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(rec)
    }).catch(() => {});
  }catch(e){}
}

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
    logToDB(kind, payload);
    return { ok:true, demo:true };
  }
  const res = await fetch(CONFIG.formEndpoint, {
    method: "POST",
    headers: CONFIG.formHeaders,
    body: JSON.stringify(payload)
  });
  if(!res.ok) throw new Error("HTTP " + res.status);
  logToDB(kind, payload);
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
  data._autoresponse = "感谢你联系 AMAS 亚洲宣教神学院！我们已收到你的资料，招生同工会尽快与你联系。Thank you for contacting AMAS — we have received your submission and will follow up with you soon.";
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
  data._autoresponse = "感谢你联系 AMAS 亚洲宣教神学院！我们已收到你的资料，招生同工会尽快与你联系。Thank you for contacting AMAS — we have received your submission and will follow up with you soon.";
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
    ["line",   "contact.lineLabel",   v => `${escapeHTML(v)} <button type="button" class="copy-btn" data-copy="${escapeHTML(v)}">${escapeHTML(t("actions.copy"))}</button>`],
    ["wechat", "contact.wechatLabel", v => `${escapeHTML(v)} <button type="button" class="copy-btn" data-copy="${escapeHTML(v)}">${escapeHTML(t("actions.copy"))}</button>`]
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

/* ===== 奉献支持：方式切换 + 通知表单 ===== */
$$(".gtab").forEach(b => b.addEventListener("click", () => {
  $$(".gtab").forEach(x => x.classList.toggle("active", x === b));
  $$(".gpane").forEach(p => p.classList.toggle("active", p.dataset.pane === b.dataset.pane));
}));
$("#givingForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget;
  if(!form.checkValidity()) return form.reportValidity();
  const data = Object.fromEntries(new FormData(form).entries());
  data._form = "giving-notice";
  data._subject = "AMAS 奉献通知 — " + (data.name || "");
  data.lang = currentLang;
  const st = $("#givingStatus");
  st.textContent = t("actions.sending");
  try{
    await sendPayload("giving", data);
    st.textContent = t("giving.ok");
    form.reset();
  }catch(err){
    st.textContent = t("giving.fail");
  }
});

/* ===== 配套 App 入口：CONFIG.app 有地址时渲染 ===== */
/* 构造带来源/评估/画像参数的 App 链接：appUrl("web", {stage:"2"}) */
function appUrl(kind, extra){
  const a = CONFIG.app || {}; const base = a[kind] || a.web; if(!base) return "";
  const q = Object.entries(Object.assign({}, a.params || {}, extra || {})).filter(([,v]) => v !== "" && v != null);
  return q.length ? base + (base.includes("?") ? "&" : "?") + q.map(([k,v]) => k + "=" + encodeURIComponent(v)).join("&") : base;
}
window.appUrl = appUrl;
(function renderAppLinks(){
  const box = $("#appLinks"); if(!box) return;
  const a = CONFIG.app || {};
  const items = [
    a.web && ["🌐 " + t("digital.app.web"), appUrl("web")],
    a.ios && ["🍎 App Store", appUrl("ios")],
    a.android && ["🤖 Android", appUrl("android")]
  ].filter(Boolean);
  if(!items.length){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = items.map(([label, href]) =>
    `<a class="app-try" href="${href}" target="_blank" rel="noopener">${label}</a>`).join("");
})();

/* ===== 开学倒计时 ===== */
function refreshCountdown(){
  const el = $("#admCountdown"); if(!el) return;
  const started = Date.now() >= new Date("2026-09-01T00:00:00+07:00").getTime();
  el.textContent = started ? t("admissions.started") : t("admissions.countdown");
}
refreshCountdown();
document.addEventListener("click", e => {
  const b = e.target.closest(".copy-btn");
  if(!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(t("toast.copied"))).catch(() => {});
});

/* ===== 招生浮标：延时/滚动触发弹出，关闭后当天不再打扰 ===== */
(function(){
  const card = $("#promoCard"), tab = $("#promoTab");
  if(!card || !tab) return;
  const KEY = "amas-promo-dismissed";
  const today = new Date().toISOString().slice(0,10);
  let dismissed = false;
  try{ dismissed = localStorage.getItem(KEY) === today; }catch(e){}
  let shown = false;
  function showCard(){ if(shown || dismissed) return; shown = true; card.classList.remove("out"); card.hidden = false; }
  function hideCard(remember){
    // 先播放向左滑出动画，再真正隐藏
    card.classList.add("out");
    setTimeout(() => { card.hidden = true; card.classList.remove("out"); }, 340);
    if(remember){ dismissed = true; try{ localStorage.setItem(KEY, today); }catch(e){} }
  }
  // 8 秒后自动弹出；或滚过首屏 60% 时弹出
  setTimeout(showCard, 8000);
  addEventListener("scroll", () => { if(scrollY > innerHeight * 0.6) showCard(); }, { passive:true });
  $("#promoClose").addEventListener("click", () => hideCard(true));
  // 侧边标签：开关式——已弹出则收回，已收回则弹出
  tab.addEventListener("click", () => {
    if(!card.hidden){ hideCard(false); return; }
    dismissed = false; shown = false; showCard();
  });
  $("#promoAsk").addEventListener("click", () => { hideCard(false); openChat(); });
  $("#promoApply").addEventListener("click", () => hideCard(false));
  // 打开客服面板或申请弹窗时自动收起，避免遮挡
  document.addEventListener("click", e => {
    if(e.target.closest("#chatFab, [data-open-application]") && !e.target.closest(".promo-card")) card.hidden = true;
  });
})();
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
    { label: t("chat.chips.human"),   fn: startHumanFlow },
    { label: t("chat.chips.leave"),   fn: startLeaveFlow }
  ]);
}

/* 站点知识库：test 对中英输入都生效 */
const CHAT_KB = [
  { test: /人工|真人|客服|活人|转人工|human|real\s*person|agent|staff|상담원|사람과|เจ้าหน้าที่|คนจริง/i,
    custom: () => startHumanFlow() },
  { test: /申请|报名|报读|apply|admission|enroll|지원|신청|입학|สมัคร|เข้าเรียน/i,
    reply: () => t("chat.kb.apply"),
    action: () => chatAction(t("actions.applyNow"), () => { closeChat(); openApplication(); }) },
  { test: /学费|费用|多少钱|缴费|tuition|fee|cost|price|등록금|학비|납부|ค่าเล่าเรียน|ค่าเทอม|ค่าใช้จ่าย/i,
    reply: () => t("chat.kb.tuition"),
    action: () => chatAction(t("chat.kb.tuitionBtn"), () => { closeChat(); $("#tuition")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /课程|课表|科目|course|curriculum|class(es)?\b|과목|커리큘럼|วิชา|รายวิชา/i,
    reply: () => t("chat.kb.courses"),
    action: () => chatAction(t("chat.kb.coursesBtn"), () => { closeChat(); $("#courses")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /学位|学制|项目|文凭|硕士|博士|b\.?th|m\.?div|dip|program|degree|학위|석사|박사|디플로마|ปริญญา|หลักสูตร/i,
    reply: () => t("chat.kb.programs"),
    action: () => chatAction(t("chat.kb.programsBtn"), () => { closeChat(); $("#programs")?.scrollIntoView({behavior:"smooth"}); }) },
  { test: /线上|线下|上课|开学|时间|授课|online|schedule|start|september|mode|온라인|수업|개강|ออนไลน์|เปิดเรียน|เรียนอย่างไร/i,
    reply: () => t("chat.kb.mode") },
  { test: /联系|微信|电话|邮箱|contact|email|phone|wechat|line\b|연락|문의|전화|이메일|ติดต่อ|โทร|อีเมล/i,
    reply: () => {
      const c = CONFIG.contact || {};
      const rows = [c.email, c.phone, c.line && "Line: " + c.line, c.wechat && ("WeChat: " + c.wechat)].filter(Boolean);
      return rows.length ? t("chat.kb.contact") + "\n" + rows.join("\n") : t("chat.kb.contactEmpty");
    } },
  { test: /学籍|毕业|颁发|文凭|学历|认证|graduat|status|accredit|학적|졸업|인증|สถานภาพ|จบการศึกษา|รับรอง/i,
    reply: () => t("faq.items.2.a") },
  { test: /背景|基础|没学过|零基础|background|beginner|배경|기초|พื้นฐาน|ไม่เคยเรียน/i,
    reply: () => t("faq.items.0.a") },
  { test: /地址|在哪|位置|清迈|泰国|where|location|address|chiang\s*mai|어디|위치|치앙마이|ที่ไหน|ที่ตั้ง|เชียงใหม่/i,
    reply: () => t("chat.kb.location") },
  { test: /视频|介绍|了解|video|introduc|영상|소개|วิดีโอ|แนะนำ/i,
    reply: () => t("chat.kb.video"),
    action: () => chatAction(t("actions.video"), () => { closeChat(); mountVideo(); openLayer(videoModal, $(".video-card", videoModal)); }) }
];

function ruleAnswer(q){
  for(const item of CHAT_KB){
    if(item.test.test(q)){
      if(item.custom){ item.custom(); return true; }
      chatMsg(item.reply(), "bot");
      item.action?.();
      return true;
    }
  }
  return false;
}

/* 人工客服：直接给出同工联系方式（微信/Line 复制、邮件直达） */
function startHumanFlow(){
  chatMsg(t("chat.human.intro"), "bot");
  const c = CONFIG.contact || {};
  const wrap = document.createElement("div");
  wrap.className = "chat-chips";
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label;
    b.addEventListener("click", fn);
    wrap.appendChild(b);
  };
  if(c.wechat) mk(t("chat.human.wechat", { id: c.wechat }), () =>
    navigator.clipboard?.writeText(c.wechat).then(() => toast(t("toast.copied"))).catch(() => {}));
  if(c.line) mk(t("chat.human.line", { id: c.line }), () =>
    navigator.clipboard?.writeText(c.line).then(() => toast(t("toast.copied"))).catch(() => {}));
  if(c.email) mk("\ud83d\udce7 " + c.email, () => { location.href = "mailto:" + c.email; });
  chatBody.appendChild(wrap);
  chatMsg(t("chat.human.note"), "bot");
  chatBody.scrollTop = chatBody.scrollHeight;
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
      _autoresponse: "感谢你联系 AMAS 亚洲宣教神学院！我们已收到你的资料，招生同工会尽快与你联系。Thank you for contacting AMAS — we have received your submission and will follow up with you soon.",
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
