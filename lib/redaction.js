const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const ID_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const LANDLINE_RE = /(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g;
const SCHOOL_RE = /(?:浙江省)?(?:[\u4e00-\u9fa5]{2,8}(?:市|区|县|镇|街道))?[\u4e00-\u9fa5]{2,16}(?:小学|实验学校|中心学校|中心校)/g;
const PERSON_RE = /(?:学生|同学|老师|校长|主任|家长)[：:]\s*[\u4e00-\u9fa5]{2,4}/g;

function redactText(input) {
  const replacements = [];
  let text = String(input).trim();

  const replace = (regex, label) => {
    text = text.replace(regex, (matched) => {
      replacements.push({ type: label, value: matched });
      return `【已隐藏${label}】`;
    });
  };

  replace(PHONE_RE, "手机号");
  replace(ID_RE, "身份证号");
  replace(LANDLINE_RE, "电话号码");
  replace(SCHOOL_RE, "学校名称");
  replace(PERSON_RE, "姓名");

  return { text, replacements };
}

function containsUrgentRisk(text) {
  return /(正在抢救|生命危险|自杀|自残|性侵|猥亵|严重暴力|报警|失踪|重大伤害|今天必须申诉|申诉期限|诉讼时效|行政复议期限)/.test(text);
}

function detectOutOfScope(text) {
  const rules = [
    { re: /(工资|薪酬|绩效工资|加班费|奖金)/, label: "工资待遇" },
    { re: /(婚假|产假|陪产假|护理假|病假|事假|休假)/, label: "休假" },
    { re: /(职称|编制|调动|聘用|辞职|人事)/, label: "职称或人事" },
    { re: /(处分|记过|解聘|年度考核申诉)/, label: "处分或申诉期限事项" },
    { re: /(教学设计|怎么上课|论文|课题|评课)/, label: "教学或论文" },
    { re: /(抑郁|焦虑症|心理咨询|情绪陪伴)/, label: "心理咨询" },
    { re: /(家校沟通技巧|怎么和家长沟通|家长投诉怎么办)/, label: "家校沟通技巧" },
  ];
  return rules.find((rule) => rule.re.test(text))?.label || "";
}

function isLikelyInScope(text) {
  return /(班主任|工作量|任务|课时|减课|午管|午自习|午休|晚托|课后服务|社团|值班|体测|体质测试|统计|打卡|材料|催交|学生行为|学生冲突|难管理|编班|德育|心理教师|学校支持|考核|拒绝|分工|轮班|弹性上下班|安全事故|体育课受伤)/.test(text);
}

module.exports = { redactText, containsUrgentRisk, detectOutOfScope, isLikelyInScope };
