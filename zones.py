#!/usr/bin/python3

import pandas, requests, sys, os, shutil, argparse, re
from datetime import datetime, timedelta, timezone
from termcolor import colored
sys.dont_write_bytecode = True

# ==============================================================================
# GENERAL CONFIGURATION
# ==============================================================================
UTC_OFFSET = 8 # e.g., 8 for GMT+8 (Malaysia/Singapore), 4 for GMT+4 (Dubai)

# DISPLAY
MONDAY = True
FIBBONANCI = True
MIDNIGHT_PRICE = True
CURRENT_PRICE  = False

# COLOR
titlecolor    = 'white'
symbolcolor   = 'cyan'
mondaycolor   = 'blue'
prevdaycolor  = 'white'
asiacolor     = 'red'
fibbcolor     = 'yellow'
londoncolor   = 'red'
halfdaycolor  = 'red'
midnightcolor = 'light_cyan'
currentpricecolor = 'light_cyan'

# Match ANSI escape sequences like "\x1b[31m" or with multiple params
# (e.g. "\x1b[1;32m"). This ensures visible_len correctly measures text width.
ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')

# Initialize session for performance
TZ = timezone(timedelta(hours=UTC_OFFSET))
session = requests.Session()
HL_INFO_URL = "https://api.hyperliquid.xyz/info"
INTERVAL_MS = {"1m": 60_000, "1d": 86_400_000}

def to_exchange_symbol(symbol, hyper=False):
    s = symbol.upper()
    if hyper:
        for suffix in ("USDT", "USDC"):
            if s.endswith(suffix):
                return s[:-len(suffix)]
        return s
    if not s.endswith(("USDT", "USDC")):
        return f"{s}USDT"
    return s

def get_hl_klines(coin, interval, limit=100, startTime=None, endTime=None):
    if endTime is None:
        endTime = int(datetime.now(timezone.utc).timestamp() * 1000)
    if startTime is None:
        startTime = endTime - INTERVAL_MS.get(interval, 60_000) * limit
    payload = {
        "type": "candleSnapshot",
        "req": {"coin": coin, "interval": interval, "startTime": startTime, "endTime": endTime},
    }
    r = session.post(HL_INFO_URL, json=payload, timeout=5)
    r.raise_for_status()
    data = r.json()
    result = [[x["t"], float(x["o"]), float(x["h"]), float(x["l"]), float(x["c"]), float(x["v"])] for x in data]
    cols = ["timestamp", "open", "high", "low", "close", "volume"]
    df = pandas.DataFrame(result, columns=cols)
    if len(df) > limit:
        df = df.iloc[-limit:].reset_index(drop=True)
    return df

def get_klines(pair, interval, limit=100, startTime=None, endTime=None, hyper=False):
    if hyper:
        return get_hl_klines(pair, interval, limit=limit, startTime=startTime, endTime=endTime)
    url = "https://fapi.binance.com/fapi/v1/klines"
    params = {"symbol": pair, "interval": interval, "limit": limit}
    if startTime is not None:
        params["startTime"] = startTime
    if endTime is not None:
        params["endTime"] = endTime
    r = session.get(url, params=params, timeout=5)
    r.raise_for_status()
    data = r.json()
    # Extract timestamp, open, high, low, close, volume
    result = [[x[0], float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5])] for x in data]
    cols = ["timestamp", "open", "high", "low", "close", "volume"]
    df = pandas.DataFrame(result, columns=cols)
    return df

def format_price(price):
    if price is None: return "N/A"
    p = float(price)
    if p >= 10000: return f"{int(p)}"
    if p >= 1000: return f"{p:.1f}"
    if p >= 10: return f"{p:.2f}"
    # Return original string if it's a very small number or other
    return str(price).rstrip('0').rstrip('.') if '.' in str(price) else str(price)

def clear_pycache():
    for root, dirs, _ in os.walk('.'):
        if '__pycache__' in dirs:
            pycache_path = os.path.join(root, '__pycache__')
            try: shutil.rmtree(pycache_path)
            except: os._exit(0)

def get_session_levels(df, date, start_hour, end_hour):
    """Filters klines for a specific date and hour range (MYT)."""
    # Convert timestamp to Local Time if not already converted
    if 'dt' not in df.columns:
        df['dt'] = pandas.to_datetime(df['timestamp'], unit='ms', utc=True).dt.tz_convert(TZ)

    dt_hours = df['dt'].dt.hour + df['dt'].dt.minute / 60.0

    mask = (df['dt'].dt.date == date) & (dt_hours >= start_hour) & (dt_hours < end_hour)
    session_df = df[mask]

    if session_df.empty:
        return None, None

    return session_df['high'].max(), session_df['low'].min()

def visible_len(text):
    return len(ANSI_RE.sub('', text or ''))

def pad_line(text, width):
    return (text or '') + ' ' * max(0, width - visible_len(text or ''))

def print_horizontal(columns, col_width=32, gap='  '):
    max_rows = max(len(c) for c in columns)
    padded = [c + [''] * (max_rows - len(c)) for c in columns]
    for row in range(max_rows):
        print(gap.join(pad_line(padded[i][row], col_width) for i in range(len(padded))))

def format_header(SYMBOL, hyper=False):
    venue = "Hyperliquid" if hyper else "Binance Futures"
    return f"{colored(venue, titlecolor, attrs=['bold'])} {colored(SYMBOL, symbolcolor, attrs=['bold'])}"

def build_symbol_lines(SYMBOL, show_london=True, show_asia_mid=True, show_opens=True, show_header=True, show_time=True, spaced_layout=False, show_london_mid=True, history_date=None, hyper=False, tomorrow=False):
    active_levels = []
    lines = []

    if spaced_layout:
        lines.append("")

    if show_header:
        lines.append(format_header(SYMBOL, hyper=hyper))
        lines.append("")

    # 1. Previous 1D Levels & Monday Open
    if history_date is not None:
        dt_end = datetime.combine(history_date, datetime.max.time()).replace(tzinfo=TZ)
        end_ms = int(dt_end.timestamp() * 1000)
        start_ms = end_ms - INTERVAL_MS["1d"] * 10
        df_1d = get_klines(SYMBOL, "1d", limit=10, startTime=start_ms, endTime=end_ms, hyper=hyper)
        df_1w = get_klines(SYMBOL, "1w", limit=5, startTime=start_ms - INTERVAL_MS["1d"] * 30, endTime=end_ms, hyper=hyper)
    else:
        df_1d = get_klines(SYMBOL, "1d", limit=10, hyper=hyper)
        df_1w = get_klines(SYMBOL, "1w", limit=5, hyper=hyper)
    df_1d['dt'] = pandas.to_datetime(df_1d['timestamp'], unit='ms', utc=True)

    # Determine current reference day to check if running on Monday
    if history_date is not None:
        ref_date = history_date
    else:
        ref_date = df_1d.iloc[-1]['dt'].date()

    if ref_date.weekday() == 0:  # Monday: use Friday candle for Prev 1D (Weekend Range handles Sat+Sun separately)
        fri_candles = df_1d[df_1d['dt'].dt.weekday == 4]
        if not fri_candles.empty:
            h1d = fri_candles.iloc[-1]['high']
            l1d = fri_candles.iloc[-1]['low']
        else:
            # Fallback: previous candle if Friday is missing
            prev_1d = df_1d.iloc[-2]
            h1d, l1d = prev_1d['high'], prev_1d['low']
    else:
        prev_1d = df_1d.iloc[-2]
        h1d, l1d = prev_1d['high'], prev_1d['low']

    active_levels.append(('Prev 1D High', h1d))
    active_levels.append(('Prev 1D Low', l1d))

    # Find the Monday 00:00 UTC that started the current week relative to ref_date.
    # Weekly candles on Binance open at Monday 00:00 UTC, so we exclude any candle
    # whose timestamp is >= that Monday — it belongs to the still-open current week
    # and may or may not appear depending on endTime, causing iloc[-2] to be wrong.
    current_week_monday = ref_date - timedelta(days=ref_date.weekday())
    current_week_start_ms = int(datetime(
        current_week_monday.year, current_week_monday.month, current_week_monday.day,
        tzinfo=timezone.utc
    ).timestamp() * 1000)
    df_1w_prev = df_1w[df_1w['timestamp'] < current_week_start_ms]
    if not df_1w_prev.empty:
        prev_1w = df_1w_prev.iloc[-1]
        h1w, l1w = prev_1w['high'], prev_1w['low']
    else:
        h1w, l1w = None, None

    monday_candle = df_1d[df_1d['dt'].dt.weekday == 0]
    monday_open = monday_candle.iloc[-1]['open'] if not monday_candle.empty else None

    # 2. Fetch Data for Time & Session Logic
    if history_date is not None:
        dt_start = datetime.combine(history_date, datetime.min.time()).replace(tzinfo=TZ)
        start_ms = int(dt_start.timestamp() * 1000)
        dt_end = datetime.combine(history_date, datetime.max.time()).replace(tzinfo=TZ)
        end_ms = int(dt_end.timestamp() * 1000)
        df_1m = get_klines(SYMBOL, "1m", limit=1500, startTime=start_ms, endTime=end_ms, hyper=hyper)
    else:
        df_1m = get_klines(SYMBOL, "1m", limit=1500, hyper=hyper)
    df_1m['dt'] = pandas.to_datetime(df_1m['timestamp'], unit='ms', utc=True).dt.tz_convert(TZ)

    if history_date is not None:
        today = history_date
        now_local = datetime.combine(history_date, datetime.max.time()).replace(tzinfo=TZ)
    else:
        last_candle_ms = df_1m.iloc[-1]['timestamp']
        now_local = datetime.fromtimestamp(last_candle_ms / 1000.0, tz=timezone.utc).astimezone(TZ)
        today = now_local.date()

    # DST & Reset Logic
    # US DST: 2nd Sunday March to 1st Sunday November
    us_dst_start = datetime(today.year, 3, 14) - timedelta(days=(datetime(today.year, 3, 14).weekday() + 1) % 7)
    us_dst_end = datetime(today.year, 11, 7) - timedelta(days=(datetime(today.year, 11, 7).weekday() + 1) % 7)
    is_us_dst = us_dst_start.date() <= today < us_dst_end.date()
    us_shift = 0 if is_us_dst else 1

    # UK DST: Last Sunday March to Last Sunday October
    uk_dst_start = datetime(today.year, 3, 31) - timedelta(days=(datetime(today.year, 3, 31).weekday() + 1) % 7)
    uk_dst_end = datetime(today.year, 10, 31) - timedelta(days=(datetime(today.year, 10, 31).weekday() + 1) % 7)
    is_uk_dst = uk_dst_start.date() <= today < uk_dst_end.date()
    uk_shift = 0 if is_uk_dst else 1

    if history_date is None:
        # Use US shift for the day reset (following NY Daily Close)
        reset_hour = 5 + us_shift
        if now_local.hour < reset_hour:
            today = (now_local - timedelta(days=1)).date()

    # Calculate Prev 1D Mid and Gap values
    mid_1d = (h1d + l1d) / 2
    sum_hm = h1d + mid_1d
    if float(sum_hm).is_integer() and int(sum_hm) % 2 != 0:
        sum_hm += 1
    hm_1d = sum_hm / 2

    sum_lm = l1d + mid_1d
    if float(sum_lm).is_integer() and int(sum_lm) % 2 != 0:
        sum_lm -= 1
    lm_1d = sum_lm / 2

    gap_1d = float(format_price(hm_1d)) - float(format_price(mid_1d))
    gap_val = round(abs(gap_1d), 4)

    if lines and lines[-1] != "": lines.append("")

    if MONDAY and today.weekday() in (0, 1): # Monday or Tuesday
        title_text = " Weekend Range "
        line = f"{title_text:=^30}"
        lines.append(colored(line, mondaycolor, attrs=['bold']))
        sat_candles = df_1d[df_1d['dt'].dt.weekday == 5]
        sun_candles = df_1d[df_1d['dt'].dt.weekday == 6]
        if sat_candles.empty or sun_candles.empty:
            lines.append(f"Weekend High : {colored('N/A', mondaycolor, attrs=['bold'])}")
            lines.append(f"Weekend Low  : {colored('N/A', mondaycolor, attrs=['bold'])}")
        else:
            sat_last = sat_candles.iloc[-1]
            sun_last = sun_candles.iloc[-1]
            weekend_high = max(sat_last['high'], sun_last['high'])
            weekend_low = min(sat_last['low'], sun_last['low'])
            weekend_mid = (weekend_high + weekend_low) / 2
            lines.append(f"Weekend High : {colored(format_price(weekend_high), mondaycolor, attrs=['bold'])}")
            lines.append(f"Weekend Mid  : {colored(format_price(weekend_mid), mondaycolor, attrs=['bold'])}")
            lines.append(f"Weekend Low  : {colored(format_price(weekend_low), mondaycolor, attrs=['bold'])}")

        if lines and lines[-1] != "": lines.append("")
        title_text = " High Level "
        line = f"{title_text:=^30}"
        lines.append(colored(line, mondaycolor, attrs=['bold']))
        lines.append(f" Prev 1W High : {colored(format_price(h1w), 'magenta', attrs=['bold'])}")
        lines.append(f" Prev 1W Low  : {colored(format_price(l1w), 'magenta', attrs=['bold'])}")
    else:
        title_text = " High Level "
        line = f"{title_text:=^30}"
        lines.append(colored(line, mondaycolor, attrs=['bold']))
        lines.append(f" Prev 1W High : {colored(format_price(h1w), 'magenta', attrs=['bold'])}")
        lines.append(f" Prev 1W Low  : {colored(format_price(l1w), 'magenta', attrs=['bold'])}")
        if MONDAY:
            if monday_candle.empty:
                lines.append(f"  Monday High : {colored('N/A', mondaycolor, attrs=['bold'])}")
                lines.append(f"  Monday Low  : {colored('N/A', mondaycolor, attrs=['bold'])}")
            else:
                monday_high = monday_candle.iloc[-1]['high']
                monday_low = monday_candle.iloc[-1]['low']
                lines.append(f"  Monday High : {colored(format_price(monday_high), mondaycolor, attrs=['bold'])}")
                lines.append(f"  Monday Low  : {colored(format_price(monday_low), mondaycolor, attrs=['bold'])}")

    if tomorrow:
        if lines and lines[-1] != "": lines.append("")
        ext_title = " Prev 1D "
        ext_line = f"{ext_title:=^30}"
        lines.append(colored(ext_line, prevdaycolor, attrs=['bold']))
        # Use today's running high/low from 1m data (today up to current time)
        today_1m = df_1m[df_1m['dt'].dt.date == today] if 'dt' in df_1m.columns else df_1m
        if not today_1m.empty:
            today_high = today_1m['high'].max()
            today_low = today_1m['low'].min()
            today_mid = (today_high + today_low) / 2
            lines.append(f" Prev 1D High : {colored(format_price(today_high), prevdaycolor, attrs=['bold'])}")
            lines.append(f" Prev 1D Mid  : {colored(format_price(today_mid), prevdaycolor, attrs=['bold'])}")
            lines.append(f" Prev 1D Low  : {colored(format_price(today_low), prevdaycolor, attrs=['bold'])}")
        else:
            lines.append(f" Prev 1D High : {colored('N/A', prevdaycolor, attrs=['bold'])}")
            lines.append(f" Prev 1D Mid  : {colored('N/A', prevdaycolor, attrs=['bold'])}")
            lines.append(f" Prev 1D Low  : {colored('N/A', prevdaycolor, attrs=['bold'])}")
    elif FIBBONANCI:
        if lines and lines[-1] != "": lines.append("")
        ext_title = " Prev 1D "
        ext_line = f"{ext_title:=^30}"
        lines.append(colored(ext_line, prevdaycolor, attrs=['bold']))
        lines.append(f" Prev 1D High : {colored(format_price(h1d), prevdaycolor, attrs=['bold'])}")
        lines.append(f" Prev 1D 75%  : {colored(format_price(hm_1d), fibbcolor, attrs=['bold'])}")
        lines.append(f" Prev 1D Mid  : {colored(format_price(mid_1d), prevdaycolor, attrs=['bold'])}")
        lines.append(f" Prev 1D 25%  : {colored(format_price(lm_1d), fibbcolor, attrs=['bold'])}")
        lines.append(f" Prev 1D Low  : {colored(format_price(l1d), prevdaycolor, attrs=['bold'])}")

    if not tomorrow:
        if lines and lines[-1] != "": lines.append("")

        title_text = " Session "
        line = f"{title_text:=^30}"
        lines.append(colored(line, asiacolor, attrs=['bold']))

        # Session (0800-1200)
        ah_12, al_12 = get_session_levels(df_1m, today, 8, 12)
        if ah_12 is not None:
            active_levels.append(('Session High 12', ah_12))
            active_levels.append(('Session Low 12', al_12))
            lines.append(f"0800-1200 High : {colored(format_price(ah_12), asiacolor, attrs=['bold'])}")
            lines.append(f"0800-1200 Low  : {colored(format_price(al_12), asiacolor, attrs=['bold'])}")
        else:
            lines.append("0800-1200 High : N/A")
            lines.append("0800-1200 Low  : N/A")

        lines.append("")

        # Session (0800-1400)
        ah_14, al_14 = get_session_levels(df_1m, today, 8, 14)
        if ah_14 is not None:
            active_levels.append(('Session High 14', ah_14))
            active_levels.append(('Session Low 14', al_14))

            h14_str = "-" if (ah_12 is not None and format_price(ah_14) == format_price(ah_12)) else format_price(ah_14)
            l14_str = "-" if (al_12 is not None and format_price(al_14) == format_price(al_12)) else format_price(al_14)

            lines.append(f"0800-1400 High : {colored(h14_str, asiacolor, attrs=['bold'])}")
            lines.append(f"0800-1400 Low  : {colored(l14_str, asiacolor, attrs=['bold'])}")
        else:
            lines.append("0800-1400 High : N/A")
            lines.append("0800-1400 Low  : N/A")

        lines.append("")

        # Session (1500-2000)
        ah_20, al_20 = get_session_levels(df_1m, today, 15, 20)
        if ah_20 is not None:
            active_levels.append(('Session High 20', ah_20))
            active_levels.append(('Session Low 20', al_20))

            prev_ah = ah_14 if ah_14 is not None else ah_12
            prev_al = al_14 if al_14 is not None else al_12

            h20_str = "-" if (prev_ah is not None and format_price(ah_20) == format_price(prev_ah)) else format_price(ah_20)
            l20_str = "-" if (prev_al is not None and format_price(al_20) == format_price(prev_al)) else format_price(al_20)

            is_weak = (ah_14 is not None and al_14 is not None and ah_20 <= ah_14 and al_20 >= al_14)
            weak_tag = f" {colored('(weak)', 'white')}" if is_weak else ""

            lines.append(f"1500-2000 High : {colored(h20_str, londoncolor, attrs=['bold'])}{weak_tag}")
            lines.append(f"1500-2000 Low  : {colored(l20_str, londoncolor, attrs=['bold'])}{weak_tag}")
        else:
            lines.append("1500-2000 High : N/A")
            lines.append("1500-2000 Low  : N/A")

        lines.append("")

        # Session (0800-2000)
        ah_0820, al_0820 = get_session_levels(df_1m, today, 8, 20)
        if ah_0820 is not None:
            active_levels.append(('Session High 0820', ah_0820))
            active_levels.append(('Session Low 0820', al_0820))

            h0820_str = "-" if (ah_20 is not None and format_price(ah_0820) == format_price(ah_20)) or (ah_14 is not None and format_price(ah_0820) == format_price(ah_14)) or (ah_12 is not None and format_price(ah_0820) == format_price(ah_12)) else format_price(ah_0820)
            l0820_str = "-" if (al_20 is not None and format_price(al_0820) == format_price(al_20)) or (al_14 is not None and format_price(al_0820) == format_price(al_14)) or (al_12 is not None and format_price(al_0820) == format_price(al_12)) else format_price(al_0820)

            # Display actual high/low values formatted
            lines.append(f"0800-2000 High : {colored(format_price(ah_0820), halfdaycolor, attrs=['bold'])}")
            lines.append(f"0800-2000 Low  : {colored(format_price(al_0820), halfdaycolor, attrs=['bold'])}")
        else:
            lines.append("0800-2000 High : N/A")
            lines.append("0800-2000 Low  : N/A")



        if MIDNIGHT_PRICE:
            if lines and lines[-1] != "": lines.append("")
            midnight_hour = 12 + us_shift
            midnight_dt = datetime.combine(today, datetime.min.time()).replace(hour=midnight_hour, tzinfo=TZ)

            if now_local < midnight_dt:
                lines.append("NY Midnight Open: N/A")
            else:
                df_after = df_1m[df_1m['dt'] >= midnight_dt]
                if not df_after.empty:
                    midnight_open = df_after.iloc[0]['open']
                    lines.append(f"NY Midnight Open: {colored(format_price(midnight_open), midnightcolor, attrs=['bold'])}")
                else:
                    lines.append("NY Midnight Open: N/A")

        if CURRENT_PRICE:
            if lines and lines[-1] != "": lines.append("")
            last_candle = df_1m.iloc[-1]
            cur_price = last_candle['close']
            cur_time = now_local.strftime("%H:%M")

            price_str = colored(format_price(cur_price), currentpricecolor, attrs=['bold'])
            if show_time:
                lines.append(f"Current At : {price_str} @ {cur_time}")
            else:
                lines.append(f"Current At : {price_str}")

    return lines

def print_explanation():
    SOLID = "━━━"
    DASH  = "╴╴╴"

    en_items = [
        (SOLID, 'white',     "White Solid   = Prev 1D High/Low"),
        (DASH,  'white',     "White Dashed  = Prev 1D Mid"),
        (DASH,  'yellow',    "Yellow Dashed = Prev 1D 25%/75%"),
        (SOLID, 'magenta',   "Magenta Solid = Prev 1W High/Low"),
        (SOLID, 'blue',      "Blue Solid    = Monday High/Low"),
        (SOLID, 'red',       "Red Solid     = Asia High/Low"),
    ]

    zh_items = [
        (SOLID, 'white',     "白色实线 = 昨日高低"),
        (DASH,  'white',     "白色虚线 = 昨日中"),
        (DASH,  'yellow',    "黄色虚线 = 昨日高低的 25%/75%"),
        (SOLID, 'magenta',   "紫色实线 = 上周高低"),
        (SOLID, 'blue',      "蓝色实线 = 周一高低"),
        (SOLID, 'red',       "红色实线 = 亚洲高低"),
    ]

    lines = []
    lines.append("")
    for bar, color, text in en_items:
        lines.append(f"{colored(bar, color, attrs=['bold'])} {text}")
    lines.append("")
    for bar, color, text in zh_items:
        lines.append(f"{colored(bar, color, attrs=['bold'])} {text}")
    print("\n".join(lines))

def print_symbol(SYMBOL, show_london=True, show_asia_mid=True, show_opens=True, history_date=None, hyper=False, explain=False, tomorrow=False):
    for i, line in enumerate(build_symbol_lines(SYMBOL, show_london, show_asia_mid, show_opens, history_date=history_date, hyper=hyper, tomorrow=tomorrow)):
        print(f"\n{line}" if i == 0 else line)
    if explain:
        print_explanation()

def print_all_symbols(symbols, history_date=None, hyper=False, explain=False, tomorrow=False):
    columns = [
        build_symbol_lines(
            sym,
            show_london=True,
            show_asia_mid=False,
            show_opens=True,
            show_header=True,
            show_time=False,
            spaced_layout=False,
            show_london_mid=False,
            history_date=history_date,
            hyper=hyper,
            tomorrow=tomorrow,
        )
        for sym in symbols
    ]
    col_width = max(max(visible_len(line) for line in col) for col in columns)
    col_width = max(col_width, 30)
    print_horizontal(columns, col_width=col_width, gap='      ')
    if explain:
        print_explanation()

def main():
    global PREV_DAY

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--all', '-all', '-a', dest='all', action='store_true')
    parser.add_argument('--symbol', '--pair', dest='symbol', default=None)
    parser.add_argument('--btc', '-btc', '--btcusdt', '-btcusdt', dest='btc', action='store_true')
    parser.add_argument('--eth', '-eth', '--ethusdt', '-ethusdt', dest='eth', action='store_true')
    parser.add_argument('--sol', '-sol', '--solusdt', '-solusdt', dest='sol', action='store_true')
    parser.add_argument('--usdc', '-usdc', '--btcusdc', '-btcusdc', dest='btcusdc', action='store_true')
    parser.add_argument('--ethusdc', '-ethusdc', dest='ethusdc', action='store_true')
    parser.add_argument('--solusdc', '-solusdc', dest='solusdc', action='store_true')
    parser.add_argument('--xau', '-xau', '--gold', '-gold', dest='xau', action='store_true')
    parser.add_argument('--hyperliquid', '--hyper', '-hyper', '-hyperliquid', dest='hyper', action='store_true')
    parser.add_argument('--history', dest='history', action='store_true')
    parser.add_argument('--monday', '-monday', '-mon', '--mon', dest='monday', action='store_true')
    parser.add_argument('--tuesday', '-tuesday', '-tue', '--tue', dest='tuesday', action='store_true')
    parser.add_argument('--wednesday', '-wednesday', '-wed', '--wed', dest='wednesday', action='store_true')
    parser.add_argument('--thursday', '-thursday', '-thu', '--thu', dest='thursday', action='store_true')
    parser.add_argument('--friday', '-friday', '-fri', '--fri', dest='friday', action='store_true')
    parser.add_argument('--yesterday', '-yesterday', '-yday', '--yday', dest='yesterday', action='store_true')
    parser.add_argument('--tomorrow', '-tomorrow', '-t', '--t', dest='tomorrow', action='store_true')
    parser.add_argument('-e', '--e', '-explain', '--explain', dest='explain', action='store_true')
    args, _ = parser.parse_known_args()

    weekday_map = {
        'monday': 0,
        'tuesday': 1,
        'wednesday': 2,
        'thursday': 3,
        'friday': 4
    }

    selected_weekday = None
    for flag, wd in weekday_map.items():
        if getattr(args, flag, False):
            selected_weekday = wd
            break

    history_date = None

    # Shared helper: resolve today_local respecting the NY daily reset
    def resolve_today_local():
        now_local = datetime.now(timezone.utc).astimezone(TZ)
        today_local = now_local.date()
        us_dst_start = datetime(today_local.year, 3, 14) - timedelta(days=(datetime(today_local.year, 3, 14).weekday() + 1) % 7)
        us_dst_end = datetime(today_local.year, 11, 7) - timedelta(days=(datetime(today_local.year, 11, 7).weekday() + 1) % 7)
        is_us_dst = us_dst_start.date() <= today_local < us_dst_end.date()
        us_shift = 0 if is_us_dst else 1
        reset_hour = 5 + us_shift
        if now_local.hour < reset_hour:
            today_local = (now_local - timedelta(days=1)).date()
        return today_local

    if selected_weekday is not None:
        today_local = resolve_today_local()
        diff = today_local.weekday() - selected_weekday
        if diff < 0:
            diff += 7
        history_date = today_local - timedelta(days=diff)
        print(f"History {history_date.strftime('%Y-%m-%d %A')}\n")
    elif args.yesterday:
        today_local = resolve_today_local()
        history_date = today_local - timedelta(days=1)
        print(f"History {history_date.strftime('%Y-%m-%d %A')}\n")
    elif args.tomorrow:
        today_local = resolve_today_local()
        tomorrow_date = today_local + timedelta(days=1)
        print(f"Tomorrow {tomorrow_date.strftime('%Y-%m-%d %A')}\n")
    elif args.history:
        try:
            val = input("[i] ENTER YYMMDD ").strip()
            history_date = datetime.strptime(val, "%y%m%d").date()
            print(f"History {history_date.strftime('%Y-%m-%d %A')}\n")
        except Exception as e:
            print(f"Invalid date format: {e}")
            clear_pycache()
            return

    try:
        hyper = args.hyper
        tomorrow = args.tomorrow
        if args.all:
            symbols = ['BTC', 'ETH', 'SOL'] if hyper else ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
            print_all_symbols(symbols, history_date=history_date, hyper=hyper, explain=args.explain, tomorrow=tomorrow)
        else:
            if args.btcusdc: SYMBOL = 'BTCUSDC'
            elif args.ethusdc: SYMBOL = 'ETHUSDC'
            elif args.solusdc: SYMBOL = 'SOLUSDC'
            elif args.eth: SYMBOL = 'ETHUSDT'
            elif args.sol: SYMBOL = 'SOLUSDT'
            elif args.btc: SYMBOL = 'BTCUSDT'
            elif args.xau: SYMBOL = 'XAUUSDT'
            elif args.symbol: SYMBOL = args.symbol.upper()
            else: SYMBOL = 'BTCUSDT'
            SYMBOL = to_exchange_symbol(SYMBOL, hyper=hyper)
            print_symbol(SYMBOL, show_london=True, history_date=history_date, hyper=hyper, explain=args.explain, tomorrow=tomorrow)

    except KeyboardInterrupt: print("\n^C Aborted.")
    except Exception as e: print(f"Error: {e}")
    finally: clear_pycache()

if __name__ == "__main__":
    main()
