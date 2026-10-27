// 工具声明：OKX 合约监控与策略（自定义界面）。默认只给信号、不下单。
import { LineChart } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'a10',
  name: 'OKX 合约监控与策略',
  tagline: '监控 OKX 合约账户的余额、持仓、盈亏、委托与成交；两套策略默认只给信号不下单，可切到模拟盘，实盘自动下单需手动解锁。',
  icon: LineChart,
  category: 'AI 助手',
  type: 'data',
  mode: 'custom',
  mainLabel: '合约监控',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
