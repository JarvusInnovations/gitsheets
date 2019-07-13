<script>
export default {
  name: 'DataSheetCell',
  props: {
    status: {
      type: String,
      default: null,
    },
    oldValue: {
      type: [String, Number],
      default: null,
    },
    newValue: {
      type: [String, Number],
      default: null,
    },
  },
  render(h) {
    let html = '';
    if (this.oldValue) {
      this.newValue = (this.oldValue) ? this.newValue : null;
    }

    return (
      <div class="DataSheetCell">
        { this.status==='updated'
          ? ( <div>
            <ins class="font-bold no-underline">{this.newValue}</ins>
            <br/>
            { this.newValue != this.oldValue
              ? <del class="italic">{this.oldValue}</del>
              : <span>&nbsp;</span>
            }

          </div> )
          : this.oldValue
        }
      </div>
    );
  },
};
</script>

<style lang="postcss">
.DataSheetCell {
  @apply whitespace-no-wrap;
}
</style>
