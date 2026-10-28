"""Split a spoken-style diary into activities without inventing facts or quantities."""
from dataclasses import dataclass
import re


@dataclass(frozen=True)
class Activity:
    content: str
    category: str


CATEGORIES = (
    ('health', r'医院|看病|复诊|医生|体检|吃药|服药|量体温|洗牙|测血压'),
    ('learning', r'学习|学了|复习|预习|背单词|单词|英语|阅读|读书|作业|做.{0,8}题|上课|看书|口语|刷题|论文|考试'),
    ('exercise', r'跑步|跑了|散步|健身|游泳|瑜伽|骑车|运动|打球|羽毛球|跳绳|篮球|训练|拉伸|走了.+(?:步|公里)'),
    ('diet', r'吃|喝|早饭|早餐|午餐|午饭|晚餐|晚饭|加餐|做饭|煮饭|下厨'),
    ('work', r'上班|工作|开会|会议|加班|面试|办公|写代码|做项目|项目开发|实习'),
    ('leisure', r'电影|刷剧|电视剧|玩游戏|打游戏|听音乐|聚会|逛街|见朋友|聊天|旅游|画画'),
    ('life', r'购物|买|超市|打扫|洗衣|收拾|家务|洗碗|快递|整理房间|理发|遛狗|接孩子|银行|睡觉|睡了|午睡'),
)
TIME_WORDS = r'早上|清晨|上午|中午|午后|下午|傍晚|晚上|夜里|睡前|刚才'
ACTIONS = r'去|学|复习|预习|背|读|看|写|做|吃|喝|跑|走|散步|运动|健身|游泳|练|打|骑|买|逛|睡|上课|上班|开会|洗|收拾|整理|完成|休息|玩|听|量|测|服|陪|参加'
CONNECTOR = re.compile(rf'(?:然后|接着|之后|后来|随后|另外|此外|并且|同时|顺便|但是|不过|还|又)(?=(?:我)?(?:{TIME_WORDS})?(?:{ACTIONS}))')
TIME_BOUNDARY = re.compile(rf'(?<!^)(?=(?:{TIME_WORDS})(?:我)?(?:{ACTIONS}))')
START_ACTION = re.compile(rf'^(?:(?:{TIME_WORDS})|我|我们|已经|刚刚|刚才|在|又|还)*(?:{ACTIONS})')


def clean_fragment(value: str) -> str:
    value = value.strip(' \t，,。；;！!？?、')
    value = re.sub(r'^(?:今天我|我今天|今天|我(?!们))', '', value).strip()
    return value.strip(' ，,')


def unrealized(value: str) -> bool:
    value = re.sub(rf'^(?:(?:{TIME_WORDS})|今天|我|我们|目前|现在|还|也)*', '', value)
    return bool(re.match(
        r'^(?:明天|后天|下周|下个月|过几天|打算|准备(?!了|好|完)|计划(?!书|表)|想要|要去|要学|要做|'
        rf'(?:没有|没|未|尚未)(?:{ACTIONS}))', value))


def category_for(content: str) -> str:
    return next((category for category, pattern in CATEGORIES if re.search(pattern, content)), 'other')


def split_narration(text: str) -> tuple[list[Activity], list[str]]:
    entries: list[str] = []
    skipped: list[str] = []
    for sentence in re.split(r'[。！？!?；;\n]+', text):
        sentence = sentence.strip()
        if not sentence:
            continue
        # A future-only sentence should not turn into completed activities merely
        # because it contains several time words or conjunctions.
        if unrealized(clean_fragment(sentence)) and not re.search(r'但是|不过|后来|实际|最后', sentence):
            skipped.append(sentence)
            continue
        chunks = CONNECTOR.sub('，', sentence)
        previous: int | None = None
        for clause in re.split(r'[，,]+', chunks):
            clause = clause.strip()
            if unrealized(clean_fragment(clause)):
                skipped.append(clause)
                previous = None
                continue
            for fragment in TIME_BOUNDARY.sub('，', clause).split('，'):
                fragment = clean_fragment(fragment)
                if not fragment:
                    continue
                if unrealized(fragment):
                    skipped.append(fragment)
                    previous = None
                elif previous is not None and not START_ACTION.search(fragment) and category_for(fragment) == 'other':
                    # Keep food lists and qualifications attached to their activity.
                    entries[previous] += '，' + fragment
                else:
                    entries.append(fragment)
                    previous = len(entries) - 1
    return [Activity(content, category_for(content)) for content in entries], skipped
