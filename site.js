(function () {
  // Text area auto-resize
  const textarea = document.getElementById('itemsInput');
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', autoResize, false);
  autoResize();

  // Alpine data
  document.addEventListener('alpine:init', () => {
    Alpine.data('spill', () => ({
      total: '73150',
      items: '30000 ari\n27500 roy\n9000 ari roy roy',
      error: null,
      parsedData: null,

      compute() {
        try {
          // Parse total
          const total = Math.floor(this.total.trim());
          if (!(total > 0)) {
            throw Error('Total is invalid');
          }

          // Parse items
          const peopleTotal = {};
          let proratedTotal = 0;
          const items = this.items
            .split('\n')
            .map((item) => item.trim().toUpperCase())
            .filter((item) => item)
            .map((item, itemIndex) => {
              const args = item
                .split(' ')
                .map((arg) => arg.trim())
                .filter((arg) => arg);

              // Parse price
              const price = Math.floor(args[0]);
              if (!(price > 0)) {
                throw Error(`Item ${itemIndex + 1} has invalid price`);
              }

              // Parse people
              const people = args.slice(1);
              if (args.length < 2) {
                throw Error(`Item ${itemIndex + 1} has no person name`);
              }
              const proratedPrice = Math.round(price / people.length);
              proratedTotal += proratedPrice * people.length;
              const result = {
                no: itemIndex + 1,
                price: price,
                priceWithFee: null,
                people: {},
              };
              people.forEach((person) => {
                result.people[person] = (result.people[person] || 0) + proratedPrice;
                peopleTotal[person] = 0;
              });
              return result;
            });
          if (!items.length) {
            throw Error(`Items are empty`);
          }

          // Calculate and apply fee
          let totalPrice = 0;
          let totalPriceWithFee = 0;
          const feePercentage = (total - proratedTotal) / proratedTotal;
          items.forEach((item) => {
            item.priceWithFee = Math.round(item.price * (1 + feePercentage));
            Object.keys(item.people).forEach((person) => {
              item.people[person] = Math.round(item.people[person] * (1 + feePercentage));
              peopleTotal[person] += item.people[person];
            });
            totalPrice += item.price;
            totalPriceWithFee += item.priceWithFee;
          });

          this.error = null;
          this.parsedData = {
            people: Object.keys(peopleTotal).sort(),
            feePercentage: Math.round(feePercentage * 1000) / 10,
            items,
            totalPrice,
            totalPriceWithFee,
            peopleTotal,
          };
        } catch (e) {
          this.error = e.message;
          this.parsedData = null;
        }
      },
      select(e) {
        e.target.select();
      },
      formatNumber(num) {
        return num != null ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
      },

      init() {
        this.compute();
        this.$watch('total', () => this.compute());
        this.$watch('items', () => this.compute());
      },
    }));
  });
})();
