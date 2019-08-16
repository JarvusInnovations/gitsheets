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
  },
});
