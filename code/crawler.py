import asyncio
import csv
import json
import os
from playwright.async_api import async_playwright

class ToxicDataCrawler:
    def __init__(self, headless=False):
        self.headless = headless

    def load_existing_data(self, filename="d:/DATN/code/toxic_dataset.json"):
        import os
        if not os.path.exists(filename):
            return []
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            return []

    async def crawl_voz_forums(self, forum_urls, max_forum_pages=2, max_thread_pages=5, existing_contents=None, save_callback=None):
        """
        Crawl dữ liệu từ danh sách các box VOZ
        Quét các thớt theo page, vào từng thread để thu thập comment.
        Không lấy thông tin account/username. Không lấy đoạn quote log.
        """
        comments_data = []
        if existing_contents is None:
            existing_contents = set()
        
        async with async_playwright() as p:
            # Dùng channel="chrome" để xài Chrome thật của máy (giảm tỷ lệ bị Cloudflare/Voz chặn)
            browser = await p.chromium.launch(
                headless=self.headless,
                channel="chrome",
                args=["--disable-blink-features=AutomationControlled"]
            )
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 720}
            )
            page = await context.new_page()
            
            for forum_url in forum_urls:
                print(f"\n[VOZ] ĐANG QUÉT BOX: {forum_url}")
                
                for f_page in range(1, max_forum_pages + 1):
                    # Định dạng phân trang: https://voz.vn/f/diem-bao.33/page-2
                    base_url = forum_url.rstrip('/')
                    current_forum_url = f"{base_url}/page-{f_page}" if f_page > 1 else base_url
                    
                    print(f"\n  >> Đang lấy danh sách bài viết từ trang {f_page}: {current_forum_url}")
                    try:
                        await page.goto(current_forum_url, timeout=60000, wait_until='domcontentloaded')
                        await page.wait_for_selector('.structItem-title a', timeout=60000)
                    except Exception as e:
                        print(f"     [LỖI] Không thể tải trang box {current_forum_url}: {e}")
                        continue
                    
                    # Lấy tất cả các URL của bài viết trong trang hiện tại
                    thread_elements = await page.query_selector_all('.structItem-title a')
                    thread_links = []
                    for el in thread_elements:
                        href = await el.get_attribute('href')
                        # Lọc các link của bài viết (/t/ là format thread của voz)
                        if href and '/t/' in href and 'unread' not in href and 'latest' not in href:
                            full_url = "https://voz.vn" + href if href.startswith('/') else href
                            full_url = full_url.split('#')[0].split('/unread')[0].split('/latest')[0]
                            if full_url not in thread_links:
                                thread_links.append(full_url)
                    
                    print(f"  >> Đã tìm thấy {len(thread_links)} bài viết ở trang này.")
                    
                    # Duyệt qua từng bài viết để lấy comment
                    for thread_url in thread_links:
                        print(f"     -> Vào thread: {thread_url}")
                        for t_page in range(1, max_thread_pages + 1):
                            t_base_url = thread_url.rstrip('/')
                            current_thread_url = f"{t_base_url}/page-{t_page}" if t_page > 1 else t_base_url
                            
                            try:
                                await page.goto(current_thread_url, timeout=60000, wait_until='domcontentloaded')
                                await page.wait_for_selector('.message-inner', timeout=10000)
                            except Exception:
                                # Không tìm thấy comment hoặc đã duyệt hết các trang của thread này
                                break
                            
                            messages = await page.query_selector_all('.message-inner')
                            if not messages:
                                break
                            
                            for msg in messages:
                                # Chỉ lấy nội dung bình luận
                                content_element = await msg.query_selector('.bbWrapper')
                                if content_element:
                                    # Đoạn script này giúp xóa đi những đoạn quote (block quote) để tránh lấy lại comment cũ
                                    content = await content_element.evaluate('''el => { 
                                        let clone = el.cloneNode(true); 
                                        clone.querySelectorAll('blockquote').forEach(e => e.remove()); 
                                        return clone.innerText; 
                                    }''')
                                    
                                    # Loại bỏ dòng trống, chuỗi cách, enter thừa thãi
                                    clean_content = ' '.join(content.split())
                                    
                                    # Lọc bớt các câu quá ngắn không mang nhiều thông tin tranh luận
                                    if len(clean_content) > 15 and clean_content not in existing_contents:
                                        existing_contents.add(clean_content)
                                        comments_data.append({
                                            "platform": "voz",
                                            "content": clean_content,
                                            "label": ""
                                        })
                            
                            # Nếu page không có nút next page thì nghĩa là đã tới trang comment cuối cùng, có thể thoát ra
                            next_button = await page.query_selector('a.pageNav-jump--next')
                            if not next_button:
                                break
                                
                        # Lưu dữ liệu sau mỗi bài viết để tránh mất mát nếu bị ngắt giữa chừng
                        if save_callback and len(comments_data) > 0:
                            save_callback(comments_data)
                                
                    # Đợi tí xíu khi đổi forum page để tránh lag
                    await asyncio.sleep(2)
                    
            await browser.close()
            
        return comments_data

    async def crawl_youtube_comments(self, video_url, scrolls=10):
        """ Giữ lại method youtube phòng khi cần chạy """
        comments_data = []
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=self.headless)
            page = await browser.new_page()
            print(f"[Youtube] Đang mở video: {video_url}")
            await page.goto(video_url)
            await page.wait_for_load_state('networkidle')
            await page.evaluate("window.scrollBy(0, 500)")
            await asyncio.sleep(2)
            
            for i in range(scrolls):
                print(f"[Youtube] Đang cuộn lần {i+1}/{scrolls}...")
                await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                await asyncio.sleep(2)
            
            comments = await page.query_selector_all('ytd-comment-thread-renderer')
            for c in comments:
                content_el = await c.query_selector('#content-text')
                if content_el:
                    content = await content_el.inner_text()
                    clean_content = ' '.join(content.split())
                    if clean_content:
                        comments_data.append({
                            "platform": "youtube",
                            "content": clean_content,
                            "label": ""
                        })
            await browser.close()
        return comments_data

    def save_data(self, data, filename="dataset.csv"):
        if not data:
            print("Không có dữ liệu mới để lưu.")
            return

        os.makedirs(os.path.dirname(filename) if os.path.dirname(filename) else '.', exist_ok=True)
        csv_filename = filename if filename.endswith('.csv') else f"{filename}.csv"
        # Chỉ lưu platform, content và label
        keys = ["platform", "content", "label"]
        with open(csv_filename, 'w', encoding='utf-8-sig', newline='') as f:
            dict_writer = csv.DictWriter(f, fieldnames=keys)
            dict_writer.writeheader()
            dict_writer.writerows(data)
        print(f"Đã lưu thành công {len(data)} dòng dữ liệu vào tệp: {csv_filename}")

        json_filename = csv_filename.replace('.csv', '.json')
        with open(json_filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
        print(f"Đã lưu thành công JSON vào tệp: {json_filename}")


if __name__ == "__main__":
    # Đã sửa thành headless=False để hiển thị cửa sổ trình duyệt (giúp vượt qua Cloudflare/Captcha)
    crawler = ToxicDataCrawler(headless=False) 
    all_data = []

    existing_data = crawler.load_existing_data("d:/DATN/code/toxic_dataset.json")
    existing_contents = set(item['content'] for item in existing_data if 'content' in item)
    print(f"Đã tải {len(existing_data)} dữ liệu cũ để tránh trùng lặp.")
    
    all_data.extend(existing_data)

    print("--- BẮT ĐẦU CHẠY CRAWLER BÀI VIẾT VOZ ---")
    print(" LƯU Ý: Trình duyệt sẽ mở ra. Nếu gặp màn hình xác thực Cloudflare 'Verify you are human', bạn hãy bấm tay vào nhé!")
    
    voz_forums = [
        "https://voz.vn/f/chuyen-tro-linh-tinh™.17/"
    ]
    
    data_voz = []
    def save_incremental(new_data):
        # Kết hợp dữ liệu cũ để lưu
        temp_data = list(existing_data)
        temp_data.extend(new_data)
        crawler.save_data(temp_data, "d:/DATN/code/toxic_dataset.csv")

    try:
        data_voz = asyncio.run(crawler.crawl_voz_forums(
            forum_urls=voz_forums, 
            max_forum_pages=15,   
            max_thread_pages=10,
            existing_contents=existing_contents,
            save_callback=save_incremental
        ))
        all_data.extend(data_voz)
    except KeyboardInterrupt:
        print("\n[CẢNH BÁO] Tiến trình đã bị ép dừng. Dữ liệu một phần đã được lưu trong quá trình thu thập.")
    except Exception as e:
        print(f"\n[LỖI] Đã xảy ra lỗi: {e}")
    finally:
        # Lưu lần cuối để đảm bảo
        temp_data = list(existing_data)
        temp_data.extend(all_data if all_data else data_voz)
        crawler.save_data(temp_data, "d:/DATN/code/toxic_dataset.csv")
        print("--- CRAWLER HOÀN TẤT ---")
