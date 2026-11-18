import './styles/main.css';
import { mountSearchPage } from './components/search-page.js';

const root = document.getElementById('app');
const controller = mountSearchPage(root);

// HMR 热更新时清理定时器与在途请求，避免重复挂载
if (import.meta.hot) {
  import.meta.hot.dispose(() => controller.destroy());
}

// 页面卸载前取消在途请求
window.addEventListener('beforeunload', () => controller.destroy());
