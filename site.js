(() => {
  // Alpine data
  document.addEventListener('alpine:init', () => {
    Alpine.data('spill', function () {
      // Query params operations
      const getParams = () => {
        const params = {};
        const search = window.location.search;
        if (search) {
          search
            .substring(1)
            .split('&')
            .forEach((param) => {
              const [key, value] = param.split('=');
              params[key] = decodeURIComponent(value).replace(/\+/g, ' ').replace(/\|/g, '\n');
            });
        }
        return params;
      };
      const setParams = (params) => {
        const search = Object.keys(params)
          .map((key) => `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+').replace(/%0A/g, '|')}`)
          .join('&');
        window.history.replaceState(null, null, `?${search}`);
      };
      const formatDate = (date) => {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[date.getMonth()];
        const day = date.getDate();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month} ${day}, ${hours}:${minutes}`;
      };

      // Settle credits and debts efficiently
      const settleBalances = (balances) => {
        // Separate creditors and debtors then sort them
        const creditors = [];
        const debtors = [];
        balances.forEach((balance, index) => {
          if (balance > 0) {
            creditors.push({ index, amount: balance });
          } else if (balance < 0) {
            debtors.push({ index, amount: -balance });
          }
        });
        creditors.sort((a, b) => b.amount - a.amount);
        debtors.sort((a, b) => b.amount - a.amount);

        const transactions = [];
        while (creditors.length && debtors.length) {
          // Match the biggest credit and debt
          const creditor = creditors[0];
          const debtor = debtors[0];
          const transaction = {
            from: debtor.index,
            to: creditor.index,
            amount: Math.min(creditor.amount, debtor.amount),
          };
          transactions.push(transaction);

          // Prepare the lists for the next pass
          if (creditor.amount === transaction.amount) {
            creditors.shift();
          } else {
            creditor.amount -= transaction.amount;
            creditors.sort((a, b) => b.amount - a.amount);
          }
          if (debtor.amount === transaction.amount) {
            debtors.shift();
          } else {
            debtor.amount -= transaction.amount;
            debtors.sort((a, b) => b.amount - a.amount);
          }
        }

        // The lists should both be empty
        if (creditors.length || debtors.length) {
          throw Error('Credits and debts are not balanced');
        }

        return transactions;
      };

      const copyText = async (text) => {
        // Copy using execCommand
        const el = document.createElement('textarea');
        el.style.opacity = 0;
        document.body.appendChild(el);
        el.value = text;
        el.focus();
        el.select();
        const result = document.execCommand && document.execCommand('copy');
        el.remove();
        if (result === true) return true;

        // Copy using navigator.clipboard
        if (navigator.clipboard) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch {}
        }

        return false;
      };

      const notyf = new Notyf({
        ripple: false,
        position: { x: 'center' },
      });

      return {
        // Data
        total: '73150',
        items: '30000\n27500\n9000',
        people: 'ani\nroy\nani roy roy',
        error: null,
        billData: null,
        mbrData: this.$persist({ people: [], bills: [] }),

        // Actions
        compute() {
          try {
            if (this.items !== this.items.replace(/\+|\|/g, '')) {
              throw Error('Cannot use restricted characters: "+", "|"');
            }

            // Parse total
            const total = Math.floor(this.total.trim());
            if (!(total > 0)) {
              throw Error('Total is not valid');
            }

            // Parse items (price) and people (array of names)
            const items = this.items
              .split('\n')
              .map((item) => item.split('-')[0].trim().toUpperCase())
              .filter((item) => item)
              .map((item, itemIndex) => {
                const price = Math.floor(item);
                if (!(price > 0)) {
                  throw Error(`Item ${itemIndex + 1} has an invalid price`);
                }
                return price;
              });
            if (!items.length) {
              throw Error('Items is empty');
            }
            const people = this.people
              .split('\n')
              .map((people) => people.split('-')[0].trim().toUpperCase())
              .filter((people) => people)
              .map((people, peopleIndex) => {
                const names = people
                  .split(' ')
                  .map((arg) => arg.trim())
                  .filter((arg) => arg);
                if (!names.length) {
                  throw Error(`Item ${peopleIndex + 1} has no valid person name`);
                }
                return names;
              });
            if (!people.length) {
              throw Error('People is empty');
            }
            if (items.length !== people.length) {
              throw Error('Number of Items and People do not match');
            }

            // Calculate fee
            const itemsTotal = items.reduce((sum, item) => sum + item, 0);
            const feePercentage = (total - itemsTotal) / itemsTotal;
            const peopleTotal = {};
            let totalPrice = 0;
            let totalPriceWithFee = 0;
            const data = items.map((item, itemIndex) => {
              const proratedPrice = Math.round(item / people[itemIndex].length);
              const datum = {
                no: itemIndex + 1,
                price: item,
                priceWithFee: Math.round(item * (1 + feePercentage)),
                people: {},
              };
              people[itemIndex].forEach((person) => {
                datum.people[person] = (datum.people[person] || 0) + Math.round(proratedPrice * (1 + feePercentage));
                peopleTotal[person] = (peopleTotal[person] || 0) + Math.round(proratedPrice * (1 + feePercentage));
              });
              totalPrice += datum.price;
              totalPriceWithFee += datum.priceWithFee;
              return datum;
            });

            // Save to bill data
            this.error = null;
            this.billData = {
              people: Object.keys(peopleTotal).sort(),
              feePercentage: Math.round(feePercentage * 1000) / 10,
              items: data,
              totalPrice,
              totalPriceWithFee,
              peopleTotal,
            };
            setParams({
              total: this.total,
              items: this.items,
              people: this.people,
            });
          } catch (e) {
            this.error = e.message;
            this.billData = null;
          }
        },
        uploadImage() {
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = 'image/*,text/plain';
          fileInput.style.display = 'none';
          document.body.appendChild(fileInput);

          fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;

            notyf.success('Processing upload...');

            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = async () => {
              // Calculate new width and height
              const maxLength = 1500;
              const newWidth = img.width > img.height ? maxLength : Math.round((img.width / img.height) * maxLength);
              const newHeight = img.width > img.height ? Math.round((img.height / img.width) * maxLength) : maxLength;

              // Set canvas dimensions
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(img.width, newWidth);
              canvas.height = Math.min(img.height, newHeight);

              // Use Pica to resize the image
              await pica().resize(img, canvas);
              const blob = await pica().toBlob(canvas, 'image/jpeg', 0.7);

              // Upload to API
              const formData = new FormData();
              formData.append('file', blob, file.name + '.resized.jpg');
              fetch('/api/upload', { method: 'POST', body: formData })
                .then((res) => res.json())
                .then((data) => {
                  if (!data || !data.total || !data.items) {
                    throw Error('Invalid JSON structure');
                  }
                  this.total = `${Math.floor(data.total)}`;
                  this.items = data.items.map(Math.floor).join('\n');
                  this.resizeTextArea();
                  notyf.success('Image processed successfully');
                })
                .catch((error) => {
                  notyf.success('Failed to upload image');
                  console.log('Image uploaded error:', error);
                })
                .finally(() => {
                  document.body.removeChild(fileInput);
                });
            };
          });
          fileInput.click();
        },
        async copy() {
          if (!this.billData?.people?.length) return;

          // Prepare summary
          let summary = `TOTAL: ${this.formatNumber(this.billData.totalPriceWithFee)}\r\n===`;
          this.billData.people.forEach((person) => {
            const personTotal = this.billData.peopleTotal[person];
            if (personTotal > 0) {
              summary += `\r\n${person}: ${this.formatNumber(personTotal)}`;
            }
          });

          // Copy to clipboard
          const result = await copyText(summary);
          result ? notyf.success('Summary copied') : notyf.error('Cannot access clipboard');
        },
        async share() {
          if (!this.billData?.people?.length) return;

          if (navigator.share) {
            // Share using Web Share API
            await navigator.share({ url: location.href });
          } else {
            // Copy to clipboard
            const result = await copyText(location.href);
            result ? notyf.success('Link copied') : notyf.error('Cannot access clipboard');
          }
        },
        mbrSave() {
          const peopleCount = this.billData?.people?.length;
          if (!peopleCount) return;

          // Ask for payer info
          const nameList = this.billData.people.map((person, index) => `${index + 1}. ${person}`).join('\n');
          const payerInfo = (
            prompt(`Stacking the bill above to be settled later. Who paid? (1 - ${peopleCount})?\n${nameList}`) || ''
          ).toUpperCase();
          const payer =
            this.billData.people[Math.floor(payerInfo) - 1] ||
            this.billData.people.find((person) => person === payerInfo);
          if (!payer) {
            notyf.error(`Please input number 1 - ${peopleCount}`);
            return;
          }

          // Ask for bill note
          const note = (prompt('Put an optional description for this bill:') || formatDate(new Date())).trim();

          // Record bill into MBR data
          this.mbrData.people = [...new Set([...this.mbrData.people, ...this.billData.people])].sort();
          this.mbrData.bills.push({
            payer,
            note,
            totalPriceWithFee: this.billData.totalPriceWithFee,
            peopleTotal: this.billData.peopleTotal,
          });
          notyf.success('Bill saved to stack');
        },
        mbrDelete(index) {
          if (!confirm('Delete this bill?')) return;
          this.mbrData.bills.splice(index, 1);
        },
        mbrClear() {
          if (!confirm('Delete all stacked bills?')) return;
          this.mbrData = { people: [], bills: [] };
          notyf.success('Bills cleared');
        },
        mbrListBalances() {
          const balanceMap = Object.fromEntries(this.mbrData.people.map((person) => [person, { credit: 0, debt: 0 }]));
          this.mbrData.bills.forEach((bill) => {
            Object.keys(bill.peopleTotal).forEach((payee) => {
              if (bill.payer === payee) return;
              balanceMap[bill.payer].credit += bill.peopleTotal[payee];
              balanceMap[payee].debt += bill.peopleTotal[payee];
            });
          });
          return this.mbrData.people.map((person) => balanceMap[person]);
        },
        mbrSettle() {
          const balances = this.mbrListBalances().map((person) => person.credit - person.debt);
          const transactions = settleBalances(balances).map((transaction) => ({
            from: this.mbrData.people[transaction.from],
            to: this.mbrData.people[transaction.to],
            amount: transaction.amount,
          }));
          return transactions;
        },
        async mbrCopy() {
          if (!this.mbrData?.people?.length) return;

          // Prepare summary
          const total = this.mbrData.bills.reduce((acc, cur) => acc + cur.totalPriceWithFee, 0);
          let summary = `TOTAL (${this.mbrData.bills.length}): ${this.formatNumber(total)}\r\n===`;
          this.mbrSettle().forEach((transaction) => {
            summary += `\r\n${transaction.from} -> ${transaction.to}: ${this.formatNumber(transaction.amount)}`;
          });

          // Copy to clipboard
          const result = await copyText(summary);
          result ? notyf.success('Summary copied') : notyf.error('Cannot access clipboard');
        },

        // Helpers
        select(e) {
          e.target.select();
        },
        formatNumber(num) {
          return num != null ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
        },
        resizeTextArea() {
          setTimeout(() => {
            const els = document.querySelectorAll('.list-input');
            let maxHeight = 0;
            els.forEach((el) => {
              el.style.height = 'auto';
              maxHeight = Math.max(maxHeight, el.scrollHeight);
            });
            els.forEach((el) => {
              el.style.height = maxHeight + 'px';
            });
          }, 0);
        },

        init() {
          // Restore from params
          const params = getParams();
          this.total = params.total || this.total;
          this.items = params.items || this.items;
          this.people = params.people || this.people;

          // Compute and watch
          this.compute();
          this.$watch('total', () => this.compute());
          this.$watch('items', () => this.compute());
          this.$watch('people', () => this.compute());

          // Resize textarea and watch
          this.resizeTextArea();
          document.querySelectorAll('.list-input').forEach((el) => {
            el.addEventListener('input', () => this.resizeTextArea(), false);
          });
        },
      };
    });
  });
})();
