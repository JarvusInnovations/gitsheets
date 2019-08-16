import Vue from 'vue'
import Router from 'vue-router'
import Sheet from '@/views/Sheet'

Vue.use(Router)

export default new Router({
  mode: 'history',
  routes: [
    {
      path: '/:gitRef?',
      name: 'sheet',
      component: Sheet,
      props: true,
    },
  ],
});
