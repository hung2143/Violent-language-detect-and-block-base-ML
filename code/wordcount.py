import pandas as pd
import matplotlib.pyplot as plt
from collections import Counter
import re

# Load data
train_df = pd.read_excel(r"D:\DATN\data\12-3\train.xlsx")
val_df = pd.read_excel(r"D:\DATN\data\12-3\val.xlsx")
test_df = pd.read_excel(r"D:\DATN\data\12-3\test.xlsx")

# Rename columns
for df in [train_df, val_df, test_df]:
    if "cmt_col" in df.columns:
        df.rename(columns={"cmt_col": "text", "labels": "label"}, inplace=True)
    elif "content" in df.columns:
        df.rename(columns={"content": "text", "labels": "label"}, inplace=True)

# Combine all data
all_df = pd.concat([train_df, val_df, test_df], ignore_index=True)

# Filter toxic comments (label 1 = Offensive, label 2 = Hate/harassment)
toxic_df = all_df[all_df['label'].isin([1, 2])]

# Vietnamese stopwords - FULL LIST
vietnamese_stopwords = set([
    # Đại từ
    "tôi", "tao", "tớ", "mình", "ta", "chúng", "bọn", "họ", "nó", "hắn", "ông", "bà",
    "anh", "chị", "em", "cô", "chú", "bác", "cậu", "mày", "mi", "ngươi", "người",
    "ai", "bạn", "các", "mọi", "tất", "cả",
    # Từ chỉ định
    "này", "đó", "kia", "ấy", "đây", "kìa", "đấy", "thế", "vậy",
    # Từ nối, giới từ
    "là", "và", "của", "thì", "những", "các", "tại", "bị", "bởi", "với",
    "để", "như", "trong", "trên", "dưới", "cho", "về", "khi", "có", "không",
    "gì", "nào", "đâu", "rồi", "lại", "được", "mà", "cũng", "một", "ra",
    "vì", "từ", "đã", "sẽ", "còn", "nên", "hay", "nhưng", "thế", "ở",
    "theo", "bằng", "nếu", "thì", "hoặc", "tuy", "dù", "mặc",
    # Động từ thông thường
    "đi", "làm", "vào", "lên", "xuống", "nói", "nên", "phải", "biết", "thấy",
    "xem", "nghe", "đến", "qua", "lại", "chỉ", "muốn", "cần", "bao", "cho",
    "ăn", "uống", "ngủ", "chơi", "học", "viết", "đọc", "nhìn", "xong", "xin",
    "giúp", "hỏi", "trả", "lời", "gọi", "mang", "mua", "bán", "lấy", "đưa",
    "đặt", "để", "dùng", "sử", "dụng", "tạo", "xây", "dựng", "phát", "triển",
    "nghĩ", "tưởng", "hiểu", "tin", "yêu", "ghét", "sợ", "lo", "buồn", "vui",
    "cười", "khóc", "nói", "bảo", "kể", "hát", "múa", "chạy", "nhảy", "bay",
    # Tính từ/trạng từ thông thường
    "nhiều", "ít", "lắm", "quá", "rất", "hơn", "nhất", "mấy", "bao", "sao",
    "thật", "đúng", "vậy", "thôi", "nữa", "luôn", "toàn", "hết", "xong",
    "mới", "cũ", "tốt", "xấu", "đẹp", "cao", "thấp", "dài", "ngắn", "rộng",
    "hẹp", "nhanh", "chậm", "sớm", "muộn", "trước", "sau", "giờ", "lúc",
    "khoảng", "suốt", "mãi", "liền", "ngay", "chắc", "chắn", "có lẽ",
    # Danh từ thông thường
    "cái", "con", "nhà", "việc", "chuyện", "điều", "lúc", "ngày", "năm",
    "tháng", "tuần", "giờ", "phút", "giây", "sáng", "trưa", "chiều", "tối",
    "đêm", "hôm", "nay", "mai", "qua", "kia", "trước", "sau", "đầu", "cuối",
    "giữa", "bên", "phía", "hướng", "nơi", "chỗ", "vị", "trí", "điểm",
    "công", "việc", "nghề", "nghiệp", "tiền", "bạc", "vàng", "đồ", "vật",
    "thứ", "loại", "kiểu", "dạng", "hình", "cách", "phương", "pháp", "cách",
    "nước", "đất", "trời", "biển", "sông", "núi", "rừng", "cây", "hoa", "lá",
    "thể", "thân", "người", "đầu", "mặt", "mắt", "mũi", "miệng", "tai", "tay", "chân",
    # Số đếm
    "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười",
    "trăm", "nghìn", "ngàn", "triệu", "tỷ", "nửa", "phần",
    # Từ viết tắt/teencode thông thường
    "ko", "k", "dc", "đc", "vs", "vc", "r", "nc", "cx", "đag", "bt",
    "ck", "vk", "ny", "bh", "giờ", "trc", "ns", "ik", "ak", "uh", "uk",
    # Từ đệm, cảm thán nhẹ
    "ơi", "ạ", "à", "á", "ừ", "ờ", "nhé", "nha", "nhỉ", "chứ", "đi", "thôi",
    "đấy", "vậy", "sao", "thế", "hả", "hử", "hen", "ha", "haha", "hihi",
    # Các từ khác thường gặp
    "tới", "vẫn", "đấu", "trận", "game", "video", "clip", "phim", "bài",
    "hát", "nhạc", "ảnh", "hình", "link", "web", "page", "group", "acc",
    "fb", "face", "facebook", "youtube", "tiktok", "google", "zalo"
])

# Count word frequency
def get_words(text):
    text = str(text).lower()
    text = re.sub(r'[^\w\s]', ' ', text)
    words = text.split()
    words = [w for w in words if w not in vietnamese_stopwords and len(w) > 1]
    return words

all_words = []
for text in toxic_df['text']:
    all_words.extend(get_words(text))

word_counts = Counter(all_words)
top_words = word_counts.most_common(20)

# Plot bar chart
words, counts = zip(*top_words)

plt.figure(figsize=(12, 6))
plt.barh(range(len(words)), counts, color='crimson')
plt.yticks(range(len(words)), words)
plt.xlabel('Số lần xuất hiện')
plt.ylabel('Từ')
plt.title('Top 20 từ xuất hiện nhiều nhất trong comment độc hại')
plt.gca().invert_yaxis()
plt.tight_layout()
plt.show()

print(f"Tổng số comment độc hại: {len(toxic_df)}")
print(f"\nTop 20 từ phổ biến:")
for word, count in top_words:
    print(f"  {word}: {count}")