# -*- coding: utf-8 -*-
"""把本机服务映射成公网 HTTPS 域名（给微信小程序用）。

为什么需要：微信小程序只能请求「HTTPS 合法域名」，本机 127.0.0.1 在手机上
访问不到，所以用 Cloudflare 免费快速隧道临时打通。

用法（在 _tools 目录执行）：
  python start_tunnel.py                  # 转发推送代理 8771（默认）
  python start_tunnel.py --port 8771      # 转发推送代理 8771（要收提醒时用）
  python start_tunnel.py --write-config   # 顺手把新域名写进小程序 config.js

注意：
- 每次启动域名都会变（trycloudflare 快速隧道不固定），要重新填到小程序里；
- 这个域名是临时域名，无法加入小程序后台的「request 合法域名」白名单，
  只能用于「开发版 / 预览版 + 开发者工具勾选『不校验合法域名』」；
- 走的是 --protocol http2（TCP 443），因为部分网络会拦截 QUIC 的 UDP 7844；
- 关掉本窗口（或 Ctrl+C）隧道就断了。
"""

import os
import re
import sys
import time
import argparse
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "tunnel.log")
URL_FILE = os.path.join(HERE, "tunnel_url.txt")
# 小程序工程目录（本脚本在 _tools 下，工程在上一级的 personalhub-miniprogram）
CONFIG = os.path.join(os.path.dirname(HERE), "personalhub-miniprogram", "config.js")


def find_cloudflared():
    names = ("cloudflared.exe", "cloudflared_full.exe", "cloudflared")
    # 依次在这些位置找：脚本同目录 → 上一级 → 上两级 → 完整包里的「后端/tools」
    search_dirs = [
        HERE,
        os.path.join(HERE, ".."),
        os.path.join(HERE, "..", ".."),
        os.path.join(HERE, "..", "后端", "tools"),
        os.path.join(HERE, "..", "..", "后端", "tools"),
    ]
    for d in search_dirs:
        for name in names:
            p = os.path.normpath(os.path.join(d, name))
            if os.path.exists(p):
                return p
    # 退回 PATH
    from shutil import which

    p = which("cloudflared")
    if p:
        return p
    sys.exit("[X] 没找到 cloudflared.exe。请把它放在 %s 目录下。" % HERE)


def patch_config(domain):
    if not os.path.exists(CONFIG):
        print("[!] 没找到小程序 config.js，跳过：" + CONFIG)
        return
    with open(CONFIG, encoding="utf-8") as f:
        s = f.read()
    s2, n = re.subn(r"baseUrl:\s*'[^']*'", "baseUrl: '%s'" % domain, s)
    if n == 1:
        with open(CONFIG, "w", encoding="utf-8") as f:
            f.write(s2)
        print("[OK] 已写入小程序 config.js 的 baseUrl")
    else:
        print("[!] config.js 里 baseUrl 不唯一，请手动修改")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--port",
        type=int,
        default=8771,
        help="本机要映射的端口：8770=后端，8771=推送代理（默认 8771）",
    )
    ap.add_argument(
        "--write-config", action="store_true", help="拿到域名后自动写进小程序 config.js"
    )
    args = ap.parse_args()

    exe = find_cloudflared()
    target = "http://127.0.0.1:%d" % args.port
    print("启动隧道：%s  ->  %s" % (exe, target))

    log = open(LOG, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(
        [exe, "tunnel", "--protocol", "http2", "--url", target],
        stdout=log,
        stderr=subprocess.STDOUT,
    )

    domain = ""
    try:
        for _ in range(40):
            time.sleep(1)
            try:
                text = open(LOG, encoding="utf-8", errors="replace").read()
            except Exception:
                text = ""
            m = re.search(r"https://([a-z0-9-]+\.trycloudflare\.com)", text)
            if m:
                domain = m.group(0)
                break
            if proc.poll() is not None:
                print("[X] cloudflared 已退出，日志：" + LOG)
                print(text[-800:])
                return 1
        if not domain:
            print("[X] 40 秒内没拿到域名，日志：" + LOG)
            return 1

        with open(URL_FILE, "w", encoding="utf-8") as f:
            f.write(domain + "\n")
        print()
        print("=" * 58)
        print("  公网地址：" + domain)
        print("=" * 58)
        if args.write_config:
            patch_config(domain)
        else:
            print("小程序端：数据与设置 → 服务地址 → 粘贴上面的地址 → 保存")
            print("（或在开发者工具里改 config.js 的 baseUrl）")
        print()
        print("保持本窗口开着，Ctrl+C 或关窗口即断开。")
        proc.wait()
    except KeyboardInterrupt:
        print("\n正在关闭隧道...")
    finally:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass
        log.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
