import Vue from 'vue'
import Vuex from 'vuex'
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

Vue.use(Vuex)

export default new Vuex.Store({
  state: {
    records: [],
    diffs: [],
  },
  mutations: {
    SET_RECORDS (state, records) {
      state.records = records;
    },
    SET_DIFFS (state, diffs) {
      state.diffs = diffs;
    },
    RESET_SHEET (state) {
      state.records = [];
      state.diffs = [];
    },
  },
  actions: {
    async getRecords ({ commit }, srcRef) {
      const response = await api.get(`/${srcRef}/records`);
      commit('SET_RECORDS', response.data);
    },
    async getDiffs ({ commit }, { srcRef, dstRef }) {
      const response = await api.get(`/${srcRef}/compare/${dstRef}`);
      commit('SET_DIFFS', response.data);
    },
    async merge (_context, { srcRef, dstRef }) {
      await api.post(`/${srcRef}/compare/${dstRef}`);
    },
    async import (_context, { srcRef, file, branch }) {
      await api({
        method: 'post',
        url: `/${srcRef}/import?branch=${branch}`,
        data: file,
        headers: {'content-type': 'text/csv'},
      });
    },
  },
});
