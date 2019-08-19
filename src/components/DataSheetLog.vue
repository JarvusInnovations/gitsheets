<template lang="pug">
  .DataSheetLog
    .bg-indigo-100.p-5.-m-5.border-b(v-if="changeCountTotal > 0")
      h3 Unsaved changes

      ul.DataSheetLog__stats
        li(v-for="(count, status) in changeCounts" :key="status" :class="'-status-' + status")
          FigureStat(:stat="count" :label="status")

      form(@submit.prevent="onSubmitCommit" data-test="commit-form")
        FieldLabeled.h-20(
          v-show="false"
          fieldName="message",
          fieldType="textarea",
          placeholderText="What will this commit do to the database?"
          :showLabel="false"
          required
          v-model="commitMessage")
        SubmitButton.mt-3.w-full {{ commitButtonText }}

    .b-indigo-100.p-5.-m-5.border-b
      h3 Upload new version

      form(@submit.prevent="onSubmitUpload" data-test="upload-form")
        input(type="file" name="file" accept=".csv" required ref="file" data-test="upload-file")
        SubmitButton.mt-3.w-full Select file
</template>

<script>
import commits from '../assets/data/commits.json';

import FigureStat from './FigureStat';
import FieldLabeled from './forms/FieldLabeled';
import LogCommit from './LogCommit';
import SubmitButton from './buttons/SubmitButton';

export default {
  name: 'DataSheetLog',

  components: {
    FigureStat,
    FieldLabeled,
    LogCommit,
    SubmitButton,
  },

  props: {
    records: {
      type: Array,
      required: true,
    },
  },

  data() {
    return {
      commitMessage: '',
    }
  },

  computed: {
    changeCounts () {
      return this.records.reduce((accum, record) => {
        if (record.status) {
          accum[record.status] = accum[record.status] || 0;
          accum[record.status]++;
        }
        return accum;
      }, {});
    },
    changeCountTotal () {
      return Object.values(this.changeCounts).reduce((accum, item) => accum += item, 0);
    },
    commitButtonText() {
      const noun = (this.changeCountTotal === 1) ? 'change' : 'changes';
      return `Commit ${this.changeCountTotal} ${noun}`;
    },
    defaultCommitMessage() {
      let messages = [],
        messageOutput = '';

      const counts = this.changeCounts;

      // build an array of clauses
      if (counts.added) {
        messages.push(`add ${counts.added}`);
      }

      if (counts.modified) {
        messages.push(`update ${counts.modified}`);
      }

      if (counts.removed) {
        messages.push(`remove ${counts.removed}`);
      }

      // build english list
      if (messages.length === 0) {
        messageOutput = '';
      } else if (messages.length === 1) {
        messageOutput = messages[0];
      } else if (messages.length === 2) {
        messageOutput = `${messages[0]} and ${messages[1]}`;
      } else {
        const newMessages = [...messages];
        const lastMessage = newMessages.pop();
        messageOutput = `${newMessages.join(', ')}, and ${lastMessage}`;
      }

      // capitalize and return
      return messageOutput.length
        ? messageOutput.charAt(0).toUpperCase() + messageOutput.slice(1) + ' records'
        : '';
    },
    sortedCommits() {
      return commits.sort((a, b) => {
        return new Date(b.date) - new Date(a.date);
      });
    },
  },
  watch: {
    defaultCommitMessage: {
      immediate: true,
      handler (newValue, oldValue) {
        if (!this.commitMessage || this.commitMessage === oldValue) {
          this.commitMessage = newValue;
        }
      },
    },
  },
  methods: {
    onSubmitCommit () {
      this.$emit('commit', this.commitMessage);
    },
    onSubmitUpload () {
      this.$emit('upload', this.$refs.file.files[0]);
    },
  },
}
</script>

<style scoped lang="postcss">
ul {
  @apply flex justify-between;
}

li {
  @apply flex-1;
}
</style>

<style lang="postcss">
.DataSheetLog {
  @apply border-l overflow-y-scroll px-5 py-3;

  &__stats {
    @apply mb-2;
  }
}

.-status-added {
  @apply text-green-700;
}

.-status-removed {
  @apply text-red-700;
}

.-status-modified {
  @apply text-blue-700;
}
</style>
