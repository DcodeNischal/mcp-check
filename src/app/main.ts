import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Home.vue') },
    { path: '/r/:id', component: () => import('./pages/SharedReport.vue') },
    { path: '/p/:id', component: () => import('./pages/PrivateReport.vue') },
    { path: '/servers', component: () => import('./pages/Directory.vue') },
    { path: '/:rest(.*)*', component: () => import('./pages/Home.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

createApp(App).use(router).mount('#app')
