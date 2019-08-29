import Vue from 'vue';
import Router from 'vue-router';
import Sheet from '@/views/Sheet';

Vue.use(Router);

export default new Router({
  mode: 'history',
  routes: [
    {
      path: '/records/:srcRef([\\w-\\/]+)?',
      alias: '/',
      name: 'sheet',
      component: Sheet,
      props: true,
    },
    {
      path: '/compare/:srcRef([\\w-\\/]+)..:dstRef([\\w-\\/]+)',
      name: 'compare',
      component: Sheet,
      props: true,
    },
  ],
});
