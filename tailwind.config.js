/** 设计令牌 —— 全部来自「剪辑调色棚」这一母题，不做装饰性用色 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 画布与控制台：深暖炭（调色棚环境光）
        bay: {
          950: '#0E0C0B',
          900: '#14110F',
          850: '#1A1614',
          800: '#211D1A',
          700: '#2C2724',
          600: '#3A342F',
          500: '#4A423B',
        },
        // 节点卡片：骨白纸（与深底形成“物理卡片”对比）
        bone: {
          50: '#FBF9F4',
          100: '#F5F1E8',
          200: '#E8E2D4',
          300: '#CFC7B5',
          400: '#A79E8B',
        },
        // 片头琥珀：唯一强调色（引线、运行态、时间码）
        sodium: {
          300: '#F7D79B',
          400: '#F2BE6B',
          500: '#E8A33D',
          600: '#C97F1E',
          700: '#9A5F14',
        },
        // 端口类型配色 = 功能色，不是装饰
        port: {
          text: '#8A8578',
          image: '#4C9BE8',
          video: '#B06BE8',
          audio: '#3FBF8F',
          json: '#E0B341',
          any: '#9AA0A6',
        },
        status: {
          idle: '#6B6560',
          stale: '#D9C36A',
          queued: '#8FA3C8',
          running: '#E8A33D',
          success: '#3FBF8F',
          failed: '#E2554B',
          skipped: '#5A544E',
          blocked: '#B06BE8',
        },
        danger: '#E2554B',
      },
      fontFamily: {
        display: ['Archivo', 'Bahnschrift', 'DIN Alternate', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // 基线字号整体上调（旧值 10px 在 1080p 上偏小、长时间看眼睛累）
        '2xs': ['12px', { lineHeight: '17px', letterSpacing: '0.06em' }],
        xs: ['13px', { lineHeight: '19px' }],
        sm: ['14px', { lineHeight: '21px' }],
      },
      keyframes: {
        // 运行中连线的“引线走动”
        leader: { to: { strokeDashoffset: '-24' } },
        // 运行中节点的环境脉冲
        breathe: { '0%,100%': { opacity: '0.55' }, '50%': { opacity: '1' } },
        rise: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        leader: 'leader 1s linear infinite',
        breathe: 'breathe 1.6s ease-in-out infinite',
        rise: 'rise 220ms ease-out both',
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 8px 24px -12px rgba(0,0,0,0.9)',
        dock: '0 -12px 32px -20px rgba(0,0,0,0.95)',
      },
    },
  },
  plugins: [],
};
